import { readFileSync } from "node:fs";
import { createMemoryStorage, type Fee } from "@automations/librus-data";
import type { Account, Config } from "@automations/shared";
import { countFetches, fakeRuntime } from "@automations/shared";
import { ACTIVE_NOW_BLOCK } from "@tomiwu/activities-watch";
import { describe, expect, it } from "vitest";
import { activenowLedgerExport } from "./activenow-ledger-export.ts";

const settlements = readFileSync(new URL("./fixtures/activenow-settlements.html", import.meta.url), "utf8");
const future = readFileSync(new URL("./fixtures/activenow-settlements-table-future.html", import.meta.url), "utf8");
const blocked = readFileSync(new URL("../../activities-watch/src/fixtures/activenow-blocked.html", import.meta.url), "utf8");

const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
const CHILD1 = "00000000-0000-4000-8000-0000000000c1";
const CHILD2 = "00000000-0000-4000-8000-0000000000c2";
const NOW_ACCOUNT1 = "00000000-0000-4000-8000-0000000000a1";
const NOW_ACCOUNT2 = "00000000-0000-4000-8000-0000000000a2";
const NOW_DISABLED = "00000000-0000-4000-8000-0000000000ad";
const FEE1 = "00000000-0000-4000-8000-0000000000f1";
const FEE2 = "00000000-0000-4000-8000-0000000000f2";

const LOGIN_FORM =
  '<form action="/users/sign_in"><input type="hidden" name="authenticity_token" value="tok" /><input name="user[email]" /><input type="password" name="user[password]" /></form>';
const PICKER =
  '<meta name="csrf-token" content="csrf1"><a href="/role_selector/change_role?school_user_id=1"><p>Child One</p></a><a href="/role_selector/change_role?school_user_id=2"><p>Child Two</p></a>';
const PANEL = `<nav><a href="/client_panel/settlements/index">Rozliczenia</a></nav>`;

const TODAY_ISO = "2026-04-20T10:00:00Z";

const activenow = (id: string, childId: string, group: string, enabled: boolean, login = "L1", pass = "P1"): Account => ({
  id,
  family_id: FAMILY_ID,
  child_id: childId,
  service: "activenow",
  origin: "https://activenow.example.org",
  group,
  login_secret: login,
  password_secret: pass,
  enabled,
});

const baseConfig = (): Config => ({
  family: { id: FAMILY_ID, name: "Example Family", timezone: "UTC", default_language: "en" },
  children: [
    { id: CHILD1, family_id: FAMILY_ID, name: "Child One", has_librus: true, calendar_id: null },
    { id: CHILD2, family_id: FAMILY_ID, name: "Child Two", has_librus: false, calendar_id: null },
  ],
  accounts: [
    activenow(NOW_ACCOUNT1, CHILD1, "Child One", true, "CHILD1_NOW_LOGIN", "CHILD1_NOW_PASSWORD"),
    activenow(NOW_ACCOUNT2, CHILD2, "Child Two", true, "CHILD2_NOW_LOGIN", "CHILD2_NOW_PASSWORD"),
    activenow(NOW_DISABLED, CHILD1, "Disabled", false),
  ],
  activities: [],
  recipients: [{ id: "r1", family_id: FAMILY_ID, telegram_chat_id: "1000001", language: "en", child_ids: [CHILD1, CHILD2] }],
});

const baseFee = (overrides: Partial<Fee> = {}): Fee => ({
  id: FEE1,
  familyId: FAMILY_ID,
  childId: CHILD1,
  organizer: "Example Organizer",
  recipientName: "Example Recipient",
  nip: "1234563218",
  account: "61109010140000071219812874",
  title: "Monthly tuition",
  dueDay: 20,
  notifyDay: 1,
  reminderDay: 25,
  amounts: {},
  sourceUrl: null,
  accountId: NOW_ACCOUNT1,
  enabled: true,
  ...overrides,
});

const happyAnswers: Record<string, { status: number; body: string }> = {
  "GET /users/sign_in": { status: 200, body: LOGIN_FORM },
  "POST /users/sign_in": { status: 200, body: PICKER },
  "POST /role_selector/change_role": { status: 200, body: PANEL },
  "GET /client_panel/settlements/index": { status: 200, body: settlements },
  "GET /client_panel/settlements/table": { status: 200, body: future },
};

function setup(
  answers: Record<string, { status: number; body: string }> = happyAnswers,
  config: Config = baseConfig(),
  fees: Fee[] = [baseFee()],
  now = TODAY_ISO,
) {
  const runtime = fakeRuntime({
    secrets: {
      CHILD1_NOW_LOGIN: "u1",
      CHILD1_NOW_PASSWORD: "p1",
      CHILD2_NOW_LOGIN: "u2",
      CHILD2_NOW_PASSWORD: "p2",
    },
    now: new Date(now),
    respond: (input, init) => {
      const url = new URL(input);
      const key = `${init?.method ?? "GET"} ${url.pathname}`;
      const answer = answers[key] ?? { status: 404, body: "missing" };
      return new Response(answer.body, { status: answer.status });
    },
  });
  const counter = countFetches(runtime.fetch);
  const storage = createMemoryStorage({ configs: [config], now: () => new Date(now) });
  for (const fee of fees) storage.setFee(fee);
  return {
    deps: { runtime: { ...runtime, fetch: counter.fetch }, storage, familyId: FAMILY_ID, counter },
    runtime,
    storage,
    counter,
  };
}

describe("activenowLedgerExport", () => {
  it("reads two enabled ActiveNow Accounts and skips a disabled one", async () => {
    const { deps, runtime } = setup();
    const out = await activenowLedgerExport(deps, {});
    expect(out.accounts).toHaveLength(2);
    expect(out.accounts.map((row) => row.accountId)).toEqual([NOW_ACCOUNT1, NOW_ACCOUNT2]);
    const paths = runtime.requests.map((row) => `${row.init?.method ?? "GET"} ${new URL(row.input).pathname}`);
    expect(paths).toHaveLength(10);
    expect([...new Set(paths)]).toEqual([
      "GET /users/sign_in",
      "POST /users/sign_in",
      "POST /role_selector/change_role",
      "GET /client_panel/settlements/index",
      "GET /client_panel/settlements/table",
    ]);
  });

  it("filters rows by from, counts olderRows and marks upcoming", async () => {
    const { deps } = setup(happyAnswers, baseConfig(), [baseFee()], "2026-05-15T10:00:00Z");
    const out = await activenowLedgerExport(deps, { monthsBack: 1 });
    expect(out.from).toBe("2026-05-01");
    expect(out.today).toBe("2026-05-15");
    const first = out.accounts[0]!;
    expect(first.olderRows).toBe(2);
    expect(first.rows.map((row) => row.date)).toEqual(["2026-05-01", "2026-06-01"]);
    expect(first.rows.find((row) => row.date === "2026-05-01")?.upcoming).toBe(false);
    expect(first.rows.find((row) => row.date === "2026-06-01")?.upcoming).toBe(true);
  });

  it("defaults monthsBack to 3 and merges upcoming table rows", async () => {
    const { deps } = setup();
    const out = await activenowLedgerExport(deps, {});
    expect(out.from).toBe("2026-02-01");
    const rows = out.accounts[0]!.rows;
    expect(rows).toHaveLength(4);
    expect(rows[rows.length - 1]).toMatchObject({ date: "2026-06-01", kind: "charge", upcoming: true });
  });

  it("rejects bad monthsBack and unknown keys without fetches", async () => {
    for (const input of [{ monthsBack: 0 }, { monthsBack: 7 }, { monthsBack: "3" }, { extra: 1 }]) {
      const { deps, counter } = setup();
      await expect(activenowLedgerExport(deps, input)).rejects.toThrow();
      expect(counter.count()).toEqual({ total: 0, hosts: {} });
    }
  });

  it("stops ActiveNow reads after a block page on the first Account", async () => {
    const answers = { ...happyAnswers };
    let settlementGets = 0;
    const runtime = fakeRuntime({
      secrets: { CHILD1_NOW_LOGIN: "u1", CHILD1_NOW_PASSWORD: "p1", CHILD2_NOW_LOGIN: "u2", CHILD2_NOW_PASSWORD: "p2" },
      now: new Date(TODAY_ISO),
      respond: (input, init) => {
        const path = new URL(input).pathname;
        const key = `${init?.method ?? "GET"} ${path}`;
        if (path.includes("settlements") && (init?.method ?? "GET") === "GET") {
          settlementGets += 1;
          if (settlementGets <= 2) return new Response(blocked, { status: 403 });
        }
        const answer = answers[key] ?? { status: 404, body: "missing" };
        return new Response(answer.body, { status: answer.status });
      },
    });
    const counter = countFetches(runtime.fetch);
    const storage = createMemoryStorage({ configs: [baseConfig()], now: () => new Date(TODAY_ISO) });
    storage.setFee(baseFee());
    const deps = { runtime: { ...runtime, fetch: counter.fetch }, storage, familyId: FAMILY_ID, counter };
    const out = await activenowLedgerExport(deps, {});
    expect(out.accounts).toHaveLength(2);
    expect(out.accounts.every((row) => row.error === ACTIVE_NOW_BLOCK)).toBe(true);
    expect(runtime.requests).toHaveLength(4);
  });

  it("continues with the next Account after a parse error", async () => {
    let accountReads = 0;
    const answers = { ...happyAnswers };
    const runtime = fakeRuntime({
      secrets: { CHILD1_NOW_LOGIN: "u1", CHILD1_NOW_PASSWORD: "p1", CHILD2_NOW_LOGIN: "u2", CHILD2_NOW_PASSWORD: "p2" },
      now: new Date(TODAY_ISO),
      respond: (input, init) => {
        const path = new URL(input).pathname;
        if (path === "/client_panel/settlements/index" && (init?.method ?? "GET") === "GET") {
          accountReads += 1;
          if (accountReads === 1) return new Response("<p>broken</p>", { status: 200 });
        }
        const key = `${init?.method ?? "GET"} ${path}`;
        const answer = answers[key] ?? { status: 404, body: "missing" };
        return new Response(answer.body, { status: answer.status });
      },
    });
    const counter = countFetches(runtime.fetch);
    const storage = createMemoryStorage({ configs: [baseConfig()], now: () => new Date(TODAY_ISO) });
    storage.setFee(baseFee());
    const deps = { runtime: { ...runtime, fetch: counter.fetch }, storage, familyId: FAMILY_ID, counter };
    const out = await activenowLedgerExport(deps, {});
    expect(out.accounts[0]?.error).toMatch(/site changed/);
    expect(out.accounts[0]?.rows).toEqual([]);
    expect(out.accounts[1]?.error).toBeNull();
    expect(out.accounts[1]?.rows.length).toBeGreaterThan(0);
    expect(runtime.requests).toHaveLength(9);
  });

  it("writes nothing to storage", async () => {
    const { deps, storage } = setup();
    const eventsBefore = await storage.listEvents(FAMILY_ID);
    const paymentsBefore = await storage.listPayments(FAMILY_ID);
    const notesBefore = await storage.pendingNotifications(FAMILY_ID);
    await activenowLedgerExport(deps, {});
    expect(await storage.listEvents(FAMILY_ID)).toEqual(eventsBefore);
    expect(await storage.listPayments(FAMILY_ID)).toEqual(paymentsBefore);
    expect(await storage.pendingNotifications(FAMILY_ID)).toEqual(notesBefore);
  });

  it("maps every Fee with activenowWithoutAccount", async () => {
    const fees = [
      baseFee(),
      baseFee({
        id: FEE2,
        sourceUrl: "https://school.activenow.example.com/fees",
        accountId: null,
      }),
    ];
    const { deps } = setup(happyAnswers, baseConfig(), fees);
    const out = await activenowLedgerExport(deps, {});
    expect(out.fees).toHaveLength(2);
    expect(out.fees.find((row) => row.id === FEE1)?.activenowWithoutAccount).toBe(false);
    expect(out.fees.find((row) => row.id === FEE2)?.activenowWithoutAccount).toBe(true);
  });

  it("logs summary counts without fixture titles, dates or amounts", async () => {
    const { deps, runtime } = setup();
    await activenowLedgerExport(deps, {});
    const text = runtime.logs.map((row) => row.message).join("\n");
    expect(text).toMatch(/activenow-ledger export: accounts=2 rows=8 errors=0/);
    for (const word of ["Monthly tuition", "Bank transfer", "2026-04", "15000", "150 zł"]) {
      expect(text).not.toContain(word);
    }
  });
});