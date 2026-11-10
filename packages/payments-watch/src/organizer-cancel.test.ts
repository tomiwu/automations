import { readFileSync } from "node:fs";
import { createMemoryStorage } from "@automations/librus-data";
import type { Fee } from "@automations/librus-data";
import { fakeRuntime, type Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { runPayments } from "./engine.ts";
import { createWebFeeSource } from "./page-source.ts";
import { loadCounters, type CounterStore } from "./organizer-cancel.ts";

// Issue #220: PaymentCancelled for an Organizer void or withdrawal (payments contract v0.2 section 3b). Invented data only.
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
  // A page amount that is gone gives a PaymentChanged (the amount source goes back to config): not the subject here.
  const events = async () => (await storage.listEvents(FAMILY_ID, { kinds: ["payment"] })).map((event) => event.eventType).filter((type) => type !== "PaymentChanged");
  const payment = async () => (await storage.listPayments(FAMILY_ID))[0]!;
  return { storage, store, pass, events, payment };
}

describe("PaymentCancelled for an Organizer page", () => {
  it.each([
    ["a charge that is absent", ABSENT, "organizer_void", "plain:charge_absent"],
    ["a charge that is marked cancelled", CANCELLED, "organizer_void", "plain:charge_cancelled"],
    ["a Child that is withdrawn", WITHDRAWN, "organizer_withdrawn", "plain:child_withdrawn"],
  ])("gives no event after one pass and one PaymentCancelled after two for %s", async (_name, page, reason, evidence) => {
    const { storage, pass, events, payment } = setup({ amounts: { "2025-02": 15050 } });
    await pass(LISTED);
    await pass(page);
    expect(await events()).toEqual(["PaymentDue"]);
    expect((await payment()).status).toBe("pending");
    await pass(page);
    expect(await events()).toEqual(["PaymentDue", "PaymentCancelled"]);
    expect((await payment()).status).toBe("cancelled");
    const head = (await storage.listEvents(FAMILY_ID, { kinds: ["payment"] })).at(-1)!;
    expect(head.payload).toMatchObject({ status: "cancelled", cancelReason: reason, cancelEvidence: evidence, amount: 15050 });
    expect(typeof head.payload.cancelledAt).toBe("string");
    const seqs = (await storage.listEvents(FAMILY_ID, { kinds: ["payment"] })).map((event) => event.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  });

  it("appends nothing in a third pass", async () => {
    const { pass, events } = setup({ amounts: { "2025-02": 15050 } });
    await pass(LISTED);
    await pass(ABSENT);
    await pass(ABSENT);
    const before = await events();
    await pass(ABSENT);
    expect(await events()).toEqual(before);
  });

  it.each([
    ["failed", "failed"],
    ["capped", "capped"],
    ["empty", '<table class="fees"></table>'],
    ["without fee list", "<p>Login</p>"],
  ] as const)("does not count a %s pass between two good passes, and does not cancel", async (_name, bad) => {
    const { pass, events, payment } = setup({ amounts: { "2025-02": 15050 } });
    await pass(LISTED);
    await pass(ABSENT);
    await pass(bad);
    await pass(bad);
    expect(await events()).toEqual(["PaymentDue"]);
    expect((await payment()).status).toBe("pending");
    await pass(ABSENT);
    expect(await events()).toEqual(["PaymentDue", "PaymentCancelled"]);
  });

  it("does not count a pass that makes no fetch (before notifyDay)", async () => {
    const { storage, pass, events } = setup({ amounts: { "2025-02": 15050 } });
    await pass(LISTED);
    await pass(ABSENT);
    storage.setFee({ ...fee, amounts: { "2025-02": 15050 }, notifyDay: 28 });
    await pass(ABSENT);
    await pass(ABSENT);
    expect(await events()).toEqual(["PaymentDue"]);
  });

  it("resets the count when a pass shows the charge again", async () => {
    const { pass, events } = setup({ amounts: { "2025-02": 15050 } });
    await pass(LISTED);
    await pass(ABSENT);
    await pass(LISTED);
    await pass(ABSENT);
    expect(await events()).toEqual(["PaymentDue"]);
    await pass(ABSENT);
    expect(await events()).toEqual(["PaymentDue", "PaymentCancelled"]);
  });

  it("starts at 1 when the candidate reason changes", async () => {
    const { pass, events } = setup({ amounts: { "2025-02": 15050 } });
    await pass(LISTED);
    await pass(ABSENT);
    await pass(WITHDRAWN);
    expect(await events()).toEqual(["PaymentDue"]);
    await pass(WITHDRAWN);
    expect(await events()).toEqual(["PaymentDue", "PaymentCancelled"]);
  });

  it("brings the Payment back with PaymentDue and the status pending when the charge returns", async () => {
    const { storage, pass, events, payment } = setup({ amounts: { "2025-02": 15050 } });
    await pass(LISTED);
    await pass(ABSENT);
    await pass(ABSENT);
    await pass(LISTED);
    expect(await events()).toEqual(["PaymentDue", "PaymentCancelled", "PaymentDue"]);
    expect((await payment()).status).toBe("pending");
    const head = (await storage.listEvents(FAMILY_ID, { kinds: ["payment"] })).at(-1)!;
    expect(head.seq).toBe(4);
    expect(head.payload).toMatchObject({ status: "pending", amount: 15050 });
    expect(head.payload).not.toHaveProperty("cancelReason");
    await pass(LISTED);
    expect(await events()).toHaveLength(3);
  });

  it.each(["paid", "skipped"] as const)("does not change a %s Payment", async (status) => {
    const { storage, pass, events, payment } = setup({ amounts: { "2025-02": 15050 } });
    await pass(LISTED);
    await storage.setPaymentStatus((await payment()).id, status, "1000001");
    await pass(ABSENT);
    await pass(ABSENT);
    await pass(ABSENT);
    expect(await events()).toEqual(["PaymentDue"]);
    expect((await payment()).status).toBe(status);
  });

  it("makes no cancel for a Payment that does not exist yet", async () => {
    const { pass, events } = setup({ amounts: { "2025-02": 15050 } });
    await pass(ABSENT);
    await pass(ABSENT);
    expect(await events()).toEqual(["PaymentDue"]);
  });

  it("does nothing without a counter store", async () => {
    const storage = createMemoryStorage({ configs: [config] });
    storage.setFee({ ...fee, amounts: { "2025-02": 15050 } });
    const now = new Date("2025-02-12T08:00:00Z");
    const source = createWebFeeSource({ runtime: fakeRuntime({ now, respond: () => new Response(ABSENT, { status: 200 }) }), storage, familyId: FAMILY_ID });
    for (let i = 0; i < 3; i++) await runPayments({ familyId: FAMILY_ID, storage, source, now });
    expect((await storage.listEvents(FAMILY_ID, { kinds: ["payment"] })).map((e) => e.eventType)).toEqual(["PaymentDue"]);
  });

  it("keeps no personal data in the counter store", async () => {
    const { store, pass } = setup({ amounts: { "2025-02": 15050 } });
    await pass(LISTED);
    await pass(ABSENT);
    expect([...store.values()].join("")).not.toMatch(/Example|Child One|organizer\.example/);
  });
});

describe("loadCounters", () => {
  const storeOf = (value: unknown): CounterStore => ({ get: async () => value, set: async () => undefined });

  it.each([undefined, "", "not json", "null", 5])("gives no counters for %j", async (value) => {
    expect(await loadCounters(storeOf(value))).toEqual({});
  });

  it("reads the saved counters", async () => {
    const saved = { "payment:c:f:2025-02": { reason: "organizer_void", count: 1 } };
    expect(await loadCounters(storeOf(JSON.stringify(saved)))).toEqual(saved);
  });
});
