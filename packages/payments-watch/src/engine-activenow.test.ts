import { readFileSync } from "node:fs";
import { createMemoryStorage } from "@automations/librus-data";
import type { Fee } from "@automations/librus-data";
import type { Account, Config } from "@automations/shared";
import { countFetches, fakeRuntime } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { createActiveNowFeeSource } from "./activenow-fee-source.ts";
import { createConfigFeeSource } from "./fee-source.ts";
import { runPayments } from "./engine.ts";

const settlements = readFileSync(new URL("./fixtures/activenow-settlements.html", import.meta.url), "utf8");
const future = readFileSync(new URL("./fixtures/activenow-settlements-table-future.html", import.meta.url), "utf8");
const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
const CHILD1 = "00000000-0000-4000-8000-0000000000c1";
const NOW_ACCOUNT = "00000000-0000-4000-8000-0000000000a1";

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
  login_secret: "L",
  password_secret: "P",
  enabled: true,
};

const config: Config = {
  family: { id: FAMILY_ID, name: "Example Family", timezone: "UTC", default_language: "en" },
  children: [{ id: CHILD1, family_id: FAMILY_ID, name: "Child One", has_librus: true, calendar_id: null }],
  accounts: [account],
  activities: [],
  recipients: [{ id: "r1", family_id: FAMILY_ID, telegram_chat_id: "1000001", language: "en", child_ids: [CHILD1] }],
};

const fee: Fee = {
  id: "00000000-0000-4000-8000-0000000000f1",
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
  sourceUrl: null,
  accountId: NOW_ACCOUNT,
  enabled: true,
};

function ledgerStore() {
  const data = new Map<string, string>();
  return { async get(key: string) { return data.get(key); }, async set(key: string, value: string) { data.set(key, value); } };
}

function sourceOf(now: string) {
  const answers: Record<string, { status: number; body: string }> = {
    "GET /users/sign_in": { status: 200, body: LOGIN_FORM },
    "POST /users/sign_in": { status: 200, body: PICKER },
    "POST /role_selector/change_role": { status: 200, body: PANEL },
    "GET /client_panel/settlements/index": { status: 200, body: settlements },
    "GET /client_panel/settlements/table": { status: 200, body: future },
  };
  const runtime = fakeRuntime({
    secrets: { L: "u", P: "p" },
    now: new Date(now),
    respond: (input, init) => {
      const path = new URL(input).pathname;
      const answer = answers[`${init?.method ?? "GET"} ${path}`] ?? { status: 404, body: "missing" };
      return new Response(answer.body, { status: answer.status });
    },
  });
  const storage = createMemoryStorage({ configs: [config] });
  storage.setFee(fee);
  const httpRuntime = { ...runtime, fetch: countFetches(runtime.fetch).fetch };
  return {
    storage,
    source: createActiveNowFeeSource({
      runtime: httpRuntime,
      storage,
      familyId: FAMILY_ID,
      ledgerStore: ledgerStore(),
      fallback: createConfigFeeSource(),
    }),
  };
}

describe("runPayments ActiveNow settled", () => {
  it("marks a covered month paid without Notifications", async () => {
    const { storage, source } = sourceOf("2026-04-15T08:00:00Z");
    await runPayments({ familyId: FAMILY_ID, storage, source, now: new Date("2026-04-15T08:00:00Z") });
    const [payment] = await storage.listPayments(FAMILY_ID);
    expect(payment).toMatchObject({ status: "paid", month: "2026-04", decidedBy: "organizer:activenow" });
    expect(await storage.pendingNotifications(FAMILY_ID)).toEqual([]);
    const kinds = (await storage.listEvents(FAMILY_ID)).map((event) => event.eventType);
    expect(kinds).toContain("PaymentDue");
    expect(kinds).toContain("PaymentPaid");
  });

  it("keeps Telegram Notifications for an open month", async () => {
    const { storage, source } = sourceOf("2026-05-10T08:00:00Z");
    await runPayments({ familyId: FAMILY_ID, storage, source, now: new Date("2026-05-10T08:00:00Z") });
    const [payment] = await storage.listPayments(FAMILY_ID);
    expect(payment).toMatchObject({ status: "pending", month: "2026-05" });
    expect((await storage.pendingNotifications(FAMILY_ID)).some((row) => row.key.startsWith("payment:"))).toBe(true);
  });

  it("turns a pending Payment paid when the month becomes settled", async () => {
    const store = ledgerStore();
    let settlementsBody = settlements;
    const answers: Record<string, { status: number; body: string }> = {
      "GET /users/sign_in": { status: 200, body: LOGIN_FORM },
      "POST /users/sign_in": { status: 200, body: PICKER },
      "POST /role_selector/change_role": { status: 200, body: PANEL },
      "GET /client_panel/settlements/index": { status: 200, body: settlementsBody },
      "GET /client_panel/settlements/table": { status: 200, body: future },
    };
    const runtime = fakeRuntime({
      secrets: { L: "u", P: "p" },
      now: new Date("2026-05-10T08:00:00Z"),
      respond: (input, init) => {
        const path = new URL(input).pathname;
        const answer = answers[`${init?.method ?? "GET"} ${path}`] ?? { status: 404, body: "missing" };
        return new Response(answer.body, { status: answer.status });
      },
    });
    const storage = createMemoryStorage({ configs: [config] });
    storage.setFee(fee);
    const source = createActiveNowFeeSource({
      runtime,
      storage,
      familyId: FAMILY_ID,
      ledgerStore: store,
      fallback: createConfigFeeSource(),
    });
    await runPayments({ familyId: FAMILY_ID, storage, source, now: new Date("2026-05-10T08:00:00Z") });
    expect((await storage.listPayments(FAMILY_ID))[0]).toMatchObject({ status: "pending", month: "2026-05" });
    settlementsBody = `${settlements}
      <Card>extra</Card>`.replace(
      "Monthly tuition May",
      "Monthly tuition May paid",
    );
    settlementsBody = settlements.replace(
      '<div class="hidden desktop:flex items-start">\n          <div class="w-24 flex-none">1 maja 2026</div>\n          <div class="flex-1">Monthly tuition May</div>',
      '<div class="hidden desktop:flex items-start">\n          <div class="w-24 flex-none">5 maja 2026</div>\n          <div class="flex-1">May payment</div>\n          <div class="group w-fit rounded-full px-3 py-1 green"><p>200 zł</p></div>\n        </div>\n        <div class="desktop:hidden border rounded-xl p-3"><div>May payment</div><div class="whitespace-nowrap font-semibold text-green-dark">200 zł</div><div>5 maja 2026</div></div>\n        <div class="hidden desktop:flex items-start">\n          <div class="w-24 flex-none">1 maja 2026</div>\n          <div class="flex-1">Monthly tuition May</div>',
    );
    answers["GET /client_panel/settlements/index"] = { status: 200, body: settlementsBody };
    const source2 = createActiveNowFeeSource({
      runtime: { ...runtime, now: () => new Date("2026-05-12T08:00:00Z") },
      storage,
      familyId: FAMILY_ID,
      ledgerStore: store,
      fallback: createConfigFeeSource(),
    });
    await runPayments({ familyId: FAMILY_ID, storage, source: source2, now: new Date("2026-05-12T08:00:00Z") });
    expect((await storage.listPayments(FAMILY_ID)).find((row) => row.month === "2026-05")).toMatchObject({
      status: "paid",
      decidedBy: "organizer:activenow",
    });
  });

  it("does not change a skipped Payment", async () => {
    const { storage, source } = sourceOf("2026-05-10T08:00:00Z");
    await runPayments({ familyId: FAMILY_ID, storage, source, now: new Date("2026-05-10T08:00:00Z") });
    const [payment] = await storage.listPayments(FAMILY_ID);
    await storage.setPaymentStatus(payment!.id, "skipped", "1000001");
    await runPayments({ familyId: FAMILY_ID, storage, source, now: new Date("2026-05-12T08:00:00Z") });
    expect((await storage.listPayments(FAMILY_ID)).find((row) => row.month === "2026-05")).toMatchObject({ status: "skipped" });
  });
});