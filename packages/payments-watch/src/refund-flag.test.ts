import { readFileSync } from "node:fs";
import { createMemoryStorage } from "@automations/librus-data";
import type { Fee } from "@automations/librus-data";
import { fakeRuntime, type Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { runPayments } from "./engine.ts";
import { createWebFeeSource } from "./page-source.ts";
import { loadCounters, type CounterStore } from "./organizer-cancel.ts";

const load = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const LISTED = load("organizer-fees.html");
const CANCELLED = load("organizer-fees-cancelled.html");
const ABSENT = LISTED.replace(/<tr data-month="2025-02">.*<\/tr>\n/, "");
const WITHDRAWN = LISTED.replace("</body>", '<p data-enrolled="false">Not enrolled</p></body>');

const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
const CHILD1 = "00000000-0000-4000-8000-0000000000c1";
const config: Config = {
  family: { id: FAMILY_ID, name: "Example Family", timezone: "Europe/Warsaw", default_language: "en" },
  children: [{ id: CHILD1, family_id: FAMILY_ID, name: "Child One", has_librus: true, calendar_id: null }],
  accounts: [],
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
  title: "Example fee",
  dueDay: 20,
  notifyDay: 10,
  reminderDay: 14,
  amounts: {},
  sourceUrl: "https://organizer.example.com/fees",
  accountId: null,
  enabled: true,
};

type Page = string | "failed" | "capped";

function setup(overrides: Partial<Fee> = {}) {
  const storage = createMemoryStorage({ configs: [config] });
  storage.setFee({ ...fee, ...overrides });
  const store = new Map<string, unknown>();
  const counters: CounterStore = { get: async (key) => store.get(key), set: async (key, value) => void store.set(key, value) };
  let day = 10;
  const pass = async (page: Page) => {
    const now = new Date(`2025-02-${String(day++).padStart(2, "0")}T08:00:00Z`);
    const respond = (): Response => {
      if (page === "capped") throw new Error("EntitlementLimitError: plan limit reached");
      return page === "failed" ? new Response("", { status: 500 }) : new Response(page, { status: 200 });
    };
    const runtime = fakeRuntime({ now, respond });
    const source = createWebFeeSource({ runtime, storage, familyId: FAMILY_ID });
    await runPayments({ familyId: FAMILY_ID, storage, source, now, counters });
  };
  const events = async () => (await storage.listEvents(FAMILY_ID, { kinds: ["payment"] })).map((event) => event.eventType).filter((type) => type !== "PaymentChanged");
  const payment = async () => (await storage.listPayments(FAMILY_ID))[0]!;
  const decide = async (status: "paid" | "skipped") => void (await storage.setPaymentStatus((await payment()).id, status, "1000001"));
  const texts = async () => (await storage.pendingNotifications(FAMILY_ID)).filter((entry) => entry.key.startsWith("refund-check:"));
  return { storage, pass, events, payment, decide, texts };
}

const NOTICE = "Organizer no longer lists a paid charge. Check for a refund.";

describe("refund-check flag for a paid Payment", () => {
  it("sets the flag once after two absent passes and queues one notice", async () => {
    const { pass, events, payment, decide, texts } = setup({ amounts: { "2025-02": 15050 } });
    await pass(LISTED);
    await decide("paid");
    await pass(ABSENT);
    expect((await payment()).refundCheckAt).toBeNull();
    expect(await texts()).toEqual([]);
    await pass(ABSENT);
    expect((await payment()).refundCheckAt).toEqual(new Date("2025-02-12T08:00:00Z"));
    const sent = await texts();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain(NOTICE);
    expect(sent[0]?.chatId).toBe("1000001");
    await pass(ABSENT);
    await pass(ABSENT);
    expect(await texts()).toHaveLength(1);
    expect((await payment()).refundCheckAt).toEqual(new Date("2025-02-12T08:00:00Z"));
    expect(await events()).toEqual(["PaymentDue"]);
    expect((await payment()).status).toBe("paid");
  });

  it("flags a paid Payment for a withdrawn Child too", async () => {
    const { pass, payment, decide, texts } = setup({ amounts: { "2025-02": 15050 } });
    await pass(LISTED);
    await decide("paid");
    await pass(WITHDRAWN);
    await pass(WITHDRAWN);
    expect((await payment()).refundCheckAt).not.toBeNull();
    expect(await texts()).toHaveLength(1);
  });

  it("resets the count when the charge is listed again", async () => {
    const { pass, payment, decide } = setup({ amounts: { "2025-02": 15050 } });
    await pass(LISTED);
    await decide("paid");
    await pass(ABSENT);
    await pass(LISTED);
    await pass(ABSENT);
    expect((await payment()).refundCheckAt).toBeNull();
  });

  it("does not change a skipped Payment", async () => {
    const { pass, payment, decide, texts } = setup({ amounts: { "2025-02": 15050 } });
    await pass(LISTED);
    await decide("skipped");
    await pass(ABSENT);
    await pass(ABSENT);
    await pass(ABSENT);
    expect(await payment()).toMatchObject({ status: "skipped", refundCheckAt: null });
    expect(await texts()).toEqual([]);
  });
});
