import { readFileSync } from "node:fs";
import { createMemoryStorage } from "@automations/librus-data";
import type { Fee } from "@automations/librus-data";
import { countFetches, fakeRuntime, type Account, type Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { matchLedger, parseLedger } from "./activenow-ledger.ts";
import { createActiveNowFeeSource, createPaymentFeeSource } from "./activenow-fee-source.ts";
import { createConfigFeeSource } from "./fee-source.ts";

const settlements = readFileSync(new URL("./fixtures/activenow-settlements.html", import.meta.url), "utf8");
const future = readFileSync(new URL("./fixtures/activenow-settlements-table-future.html", import.meta.url), "utf8");
const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
const CHILD1 = "00000000-0000-4000-8000-0000000000c1";
const NOW_ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
const FEE1 = "00000000-0000-4000-8000-0000000000f1";
const FEE2 = "00000000-0000-4000-8000-0000000000f2";

const LOGIN_FORM =
  '<form action="/users/sign_in"><input type="hidden" name="authenticity_token" value="tok" /><input name="user[email]" /><input type="password" name="user[password]" /></form>';
const PICKER =
  '<meta name="csrf-token" content="csrf1"><a href="/role_selector/change_role?school_user_id=1"><p>Child One</p></a>';
const PANEL = `<nav><a href="/client_panel/settlements/index">Rozliczenia</a></nav>`;

const account: Account = {
  id: NOW_ACCOUNT,
  family_id: FAMILY_ID,
  child_id: CHILD1,
  service: "activenow",
  origin: "https://activenow.example.org",
  group: "Child One",
  login_secret: "CHILD1_ACTIVENOW_LOGIN",
  password_secret: "CHILD1_ACTIVENOW_PASSWORD",
  enabled: true,
};

const config: Config = {
  family: { id: FAMILY_ID, name: "Example Family", timezone: "Europe/Warsaw", default_language: "en" },
  children: [{ id: CHILD1, family_id: FAMILY_ID, name: "Child One", has_librus: true, calendar_id: null }],
  accounts: [account],
  activities: [],
  recipients: [
    { id: "r1", family_id: FAMILY_ID, telegram_chat_id: "1000001", language: "en", child_ids: [CHILD1] },
    { id: "r2", family_id: FAMILY_ID, telegram_chat_id: "1000002", language: "pl", child_ids: [CHILD1] },
  ],
};

function baseFee(overrides: Partial<Fee> = {}): Fee {
  return {
    id: FEE1,
    familyId: FAMILY_ID,
    childId: CHILD1,
    organizer: "Example Organizer",
    recipientName: "Example Recipient",
    nip: null,
    account: "61109010140000071219812874",
    title: "Monthly tuition",
    dueDay: 20,
    notifyDay: 1,
    reminderDay: 25,
    amounts: {},
    sourceUrl: "https://school.activenow.example.com/fees",
    accountId: NOW_ACCOUNT,
    enabled: true,
    ...overrides,
  };
}

function ledgerStore() {
  const data = new Map<string, string>();
  return {
    async get(key: string) {
      return data.get(key);
    },
    async set(key: string, value: string) {
      data.set(key, value);
    },
    data,
  };
}

function happyAnswers() {
  return {
    "GET /users/sign_in": { status: 200, body: LOGIN_FORM },
    "POST /users/sign_in": { status: 200, body: PICKER },
    "POST /role_selector/change_role": { status: 200, body: PANEL },
    "GET /client_panel/settlements/index": { status: 200, body: settlements },
    "GET /client_panel/settlements/table": { status: 200, body: future },
  } as Record<string, { status: number; body: string }>;
}

function setup(now = "2026-04-20T08:00:00Z", answers = happyAnswers(), fees: Fee[] = [baseFee()]) {
  const storage = createMemoryStorage({ configs: [config] });
  fees.forEach((fee) => storage.setFee(fee));
  const store = ledgerStore();
  const runtime = fakeRuntime({
    secrets: { CHILD1_ACTIVENOW_LOGIN: "login", CHILD1_ACTIVENOW_PASSWORD: "password" },
    now: new Date(now),
    respond: (input, init) => {
      const path = new URL(input).pathname;
      const answer = answers[`${init?.method ?? "GET"} ${path}`] ?? { status: 404, body: "missing" };
      return new Response(answer.body, { status: answer.status });
    },
  });
  const counter = countFetches(runtime.fetch);
  const source = createActiveNowFeeSource({
    runtime: { ...runtime, fetch: counter.fetch },
    storage,
    familyId: FAMILY_ID,
    ledgerStore: store,
    fallback: createConfigFeeSource(),
  });
  return { storage, source, counter, store, runtime };
}

describe("createActiveNowFeeSource", () => {
  it("sums matched charges for one Fee", async () => {
    const { source } = setup();
    const found = await source.amountFor(baseFee(), "2026-04");
    expect(found).toMatchObject({ amount: 15000, source: "page" });
    expect(await source.settledFor!(baseFee(), "2026-04")).toBe(true);
    expect(await source.settledFor!(baseFee(), "2026-05")).toBe(false);
  });

  it("splits charges across several Fees by title words", async () => {
    const fees = [
      baseFee({ id: FEE1, title: "Monthly tuition" }),
      baseFee({ id: FEE2, title: "Workshop fee" }),
    ];
    const day = "2026-04-20";
    const rows = [
      { date: "2026-04-01", title: "Monthly tuition April", amount: 15000, kind: "charge" as const },
      { date: "2026-04-01", title: "Workshop fee April", amount: 9000, kind: "charge" as const },
      { date: "2026-04-10", title: "Bank transfer April", amount: 24000, kind: "payment" as const },
    ];
    const matched = matchLedger(rows, { debt: false }, day, NOW_ACCOUNT);
    const store = ledgerStore();
    await store.set(`activenow-ledger:${NOW_ACCOUNT}`, JSON.stringify({ day, rows, banner: { debt: false }, matched, readOk: true }));
    const storage = createMemoryStorage({ configs: [config] });
    fees.forEach((item) => storage.setFee(item));
    const source = createActiveNowFeeSource({
      runtime: fakeRuntime({ now: new Date(`${day}T08:00:00Z`) }),
      storage,
      familyId: FAMILY_ID,
      ledgerStore: store,
      fallback: createConfigFeeSource(),
    });
    expect(await source.amountFor(fees[0]!, "2026-04")).toMatchObject({ amount: 15000 });
    expect(await source.amountFor(fees[1]!, "2026-04")).toMatchObject({ amount: 9000 });
  });

  it("gives charge_absent observation when the month has no charge", async () => {
    const { source } = setup();
    expect(await source.amountFor(baseFee(), "2026-03")).toBeUndefined();
    expect(source.observationFor!(baseFee(), "2026-03")).toEqual({
      kind: "candidate",
      reason: "organizer_void",
      evidence: "activenow:charge_absent",
    });
  });

  it("does not use the config amount when the ledger has no charge", async () => {
    const { source } = setup(undefined, happyAnswers(), [baseFee({ amounts: { "2026-03": 9900 } })]);
    expect(await source.amountFor(baseFee({ amounts: { "2026-03": 9900 } }), "2026-03")).toBeUndefined();
  });

  it("reuses the cached ledger on a second pass the same UTC day", async () => {
    const { source, counter } = setup();
    await source.amountFor(baseFee(), "2026-04");
    const first = counter.count().total;
    await source.amountFor(baseFee(), "2026-05");
    expect(counter.count().total).toBe(first);
  });

  it("queues one unmatched open charge notice per row key", async () => {
    const day = "2026-04-20";
    const rows = [
      { date: "2026-04-01", title: "Monthly tuition April", amount: 15000, kind: "charge" as const },
      { date: "2026-03-01", title: "Extra workshop", amount: 8000, kind: "charge" as const },
    ];
    const matched = matchLedger(rows, { debt: false }, day, NOW_ACCOUNT);
    const store = ledgerStore();
    await store.set(`activenow-ledger:${NOW_ACCOUNT}`, JSON.stringify({ day, rows, banner: { debt: false }, matched, readOk: true }));
    const storage = createMemoryStorage({ configs: [config] });
    const fee = baseFee();
    storage.setFee(fee);
    storage.setFee(baseFee({ id: FEE2, title: "Swimming lessons" }));
    const source = createActiveNowFeeSource({
      runtime: fakeRuntime({ now: new Date(`${day}T08:00:00Z`) }),
      storage,
      familyId: FAMILY_ID,
      ledgerStore: store,
      fallback: createConfigFeeSource(),
    });
    await source.amountFor(fee, "2026-04");
    const keys = (await storage.pendingNotifications(FAMILY_ID)).map((row) => row.key);
    expect(keys.filter((key) => key.startsWith("activenow-unmatched:"))).toHaveLength(2);
    await source.amountFor(fee, "2026-04");
    expect((await storage.pendingNotifications(FAMILY_ID)).filter((row) => row.key.startsWith("activenow-unmatched:"))).toHaveLength(2);
  });

  it("queues one mismatch notice per day", async () => {
    const store = ledgerStore();
    const day = "2026-04-20";
    const rows = parseLedger(settlements).rows.filter((row) => row.kind === "charge" || row.kind === "payment");
    const withoutPay = rows.filter((row) => !(row.kind === "payment" && row.date === "2026-04-10"));
    const matched = matchLedger(withoutPay, { debt: false }, day, NOW_ACCOUNT);
    await store.set(`activenow-ledger:${NOW_ACCOUNT}`, JSON.stringify({ day, rows: withoutPay, banner: { debt: false }, matched, readOk: true }));
    const storage = createMemoryStorage({ configs: [config] });
    storage.setFee(baseFee());
    const runtime = fakeRuntime({ now: new Date(`${day}T08:00:00Z`), secrets: {} });
    const source = createActiveNowFeeSource({
      runtime,
      storage,
      familyId: FAMILY_ID,
      ledgerStore: store,
      fallback: createConfigFeeSource(),
    });
    await source.amountFor(baseFee(), "2026-04");
    expect((await storage.pendingNotifications(FAMILY_ID)).filter((row) => row.key.startsWith("activenow-mismatch:"))).toHaveLength(2);
    await source.amountFor(baseFee(), "2026-05");
    expect((await storage.pendingNotifications(FAMILY_ID)).filter((row) => row.key.startsWith("activenow-mismatch:"))).toHaveLength(2);
  });

  it("reads no Account that no enabled Fee uses", async () => {
    const { source, counter } = setup(undefined, undefined, [baseFee({ enabled: false }), baseFee({ id: FEE2, accountId: null, sourceUrl: null })]);
    await source.amountFor(baseFee({ id: FEE2, accountId: null, sourceUrl: null }), "2026-04");
    expect(counter.count().total).toBe(0);
  });

  it("logs a failed read and queues one failure notice a day per Recipient", async () => {
    const answers = happyAnswers();
    answers["GET /client_panel/settlements/index"] = { status: 200, body: "<html><body><p>new layout</p></body></html>" };
    const { source, storage, runtime } = setup(undefined, answers);
    expect(await source.amountFor(baseFee(), "2026-04")).toBeUndefined();
    await source.amountFor(baseFee(), "2026-04");
    expect(runtime.logs.filter((row) => row.level === "error" && row.message.startsWith("activenow ledger: read failed:"))).toHaveLength(1);
    const keys = (await storage.pendingNotifications(FAMILY_ID)).map((row) => row.key);
    expect(keys.filter((key) => key.startsWith("failure:activenow:"))).toHaveLength(2);
  });

  it("answers settledFor without a fetch", async () => {
    const { source, counter } = setup();
    expect(await source.settledFor!(baseFee(), "2026-04")).toBe(false);
    expect(counter.count().total).toBe(0);
  });

  it("stops ActiveNow reads in the pass after a block page", async () => {
    const blocked = readFileSync(new URL("../../activities-watch/src/fixtures/activenow-blocked.html", import.meta.url), "utf8");
    const second: Account = { ...account, id: "00000000-0000-4000-8000-0000000000a2", login_secret: "CHILD2_ACTIVENOW_LOGIN" };
    const wide = { ...config, accounts: [account, second] };
    const storage = createMemoryStorage({ configs: [wide] });
    storage.setFee(baseFee());
    storage.setFee(baseFee({ id: FEE2, accountId: second.id }));
    const store = ledgerStore();
    let hits = 0;
    const answers = happyAnswers();
    answers["GET /client_panel/settlements/index"] = { status: 403, body: blocked };
    const runtime = fakeRuntime({
      secrets: { CHILD1_ACTIVENOW_LOGIN: "login", CHILD1_ACTIVENOW_PASSWORD: "password", CHILD2_ACTIVENOW_LOGIN: "two", CHILD2_ACTIVENOW_PASSWORD: "two" },
      now: new Date("2026-04-20T08:00:00Z"),
      respond: (input, init) => {
        const path = new URL(input).pathname;
        if (path.includes("settlements")) hits += 1;
        const answer = answers[`${init?.method ?? "GET"} ${path}`] ?? { status: 404, body: "missing" };
        return new Response(answer.body, { status: answer.status });
      },
    });
    const counter = countFetches(runtime.fetch);
    const source = createActiveNowFeeSource({
      runtime: { ...runtime, fetch: counter.fetch },
      storage,
      familyId: FAMILY_ID,
      ledgerStore: store,
      fallback: createConfigFeeSource(),
    });
    await source.amountFor(baseFee(), "2026-04");
    expect(hits).toBe(1);
    expect(counter.count().total).toBeLessThan(10);
  });
});

describe("createPaymentFeeSource", () => {
  it("notifies when an ActiveNow sourceUrl has no accountId", async () => {
    const storage = createMemoryStorage({ configs: [config] });
    storage.setFee(baseFee({ accountId: null, sourceUrl: "https://school.activenow.example.com/fees" }));
    const runtime = fakeRuntime({ now: new Date("2026-04-20T08:00:00Z") });
    const source = createPaymentFeeSource({ runtime, storage, familyId: FAMILY_ID, ledgerStore: ledgerStore() });
    await source.amountFor(baseFee({ accountId: null }), "2026-04");
    const notice = (await storage.pendingNotifications(FAMILY_ID))[0]?.text ?? "";
    expect(notice).toContain("ActiveNow Fee needs accountId");
  });
});