import { createSupabaseStorage, type NewJournalEvent } from "@automations/librus-data";
import { createFakePostgrest } from "@automations/librus-data/fake-postgrest";
import { exampleConfig, FAMILY_ID } from "@automations/librus-data/fixtures";
import { countFetches, fakeRuntime } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { storedPaymentsExport } from "./stored-payments.ts";

const SUPABASE = "https://project.example.test";
const KEY = "test-key";
const NOW = new Date("2026-12-10T10:00:00Z");
const CHILD1 = "00000000-0000-4000-8000-0000000000c1";
const CHILD2 = "00000000-0000-4000-8000-0000000000c2";

let counter = 0;
const payment = (childId: string, month: string, dueDay: number, extra: Record<string, unknown> = {}): NewJournalEvent => ({
  familyId: FAMILY_ID, childId, seq: 1, kind: "payment", eventType: "PaymentDue", contentHash: `h${counter++}`, source: "payments-watch",
  stream: `payment:${childId}:fee${dueDay}:${month}`, day: `${month}-${String(dueDay).padStart(2, "0")}`,
  payload: {
    status: "pending", amount: 12000, amountSource: "config", dueDay, organizer: "Example Organizer", month,
    feeId: `fee${dueDay}`, childId, familyId: FAMILY_ID, notifiedAt: null, remindedAt: null, decidedAt: null, decidedBy: null,
    account: "61109010140000071219812874", nip: "1234563218", title: "Example title", recipient: "Example Recipient", sourceUrl: "https://x.example.org",
    ...extra,
  },
});

const check = (childId: string): NewJournalEvent => ({
  familyId: FAMILY_ID, childId, seq: 1, kind: "check", eventType: "CheckCompleted", contentHash: `c${counter++}`, source: "payments-watch",
  stream: `check:payments-watch:${childId}`, day: "2026-12-10", payload: { checkedAt: NOW.toISOString() },
});

async function setup(events: NewJournalEvent[], now: Date = NOW) {
  const server = createFakePostgrest(NOW, KEY);
  const config = exampleConfig();
  config.children.push({ ...config.children[0]!, id: CHILD2, name: "Child Two" });
  server.seedConfig(config);
  const supabase = { url: SUPABASE, key: KEY, fetch: server.fetch, now: () => NOW };
  await createSupabaseStorage(supabase).appendEvents(events);
  const counting = countFetches(server.fetch);
  const storage = createSupabaseStorage({ ...supabase, fetch: counting.fetch });
  const runtime = { ...fakeRuntime({ now }), fetch: counting.fetch };
  return { runtime, storage, familyId: FAMILY_ID, counter: counting };
}

describe("storedPaymentsExport", () => {
  it("defaults to the current month and orders by dueDay", async () => {
    const deps = await setup([payment(CHILD1, "2026-12", 20), payment(CHILD1, "2026-12", 5), payment(CHILD1, "2026-11", 8)]);
    const out = await storedPaymentsExport(deps);
    expect(out.month).toBe("2026-12");
    expect(out.timezone).toBe("UTC");
    expect(out.payments.map((p) => p.dueDay)).toEqual([5, 20]);
    expect(out.payments[0]).toMatchObject({ seq: 1, eventType: "PaymentDue", status: "pending", month: "2026-12", dueDay: 5 });
  });

  it("filters by Child and month", async () => {
    const deps = await setup([payment(CHILD1, "2026-12", 5), payment(CHILD2, "2026-12", 6), payment(CHILD1, "2026-11", 8)]);
    expect((await storedPaymentsExport(deps, { childId: CHILD2 })).payments.map((p) => p.childId)).toEqual([CHILD2]);
    expect((await storedPaymentsExport(deps, { month: "2026-11" })).payments.map((p) => p.dueDay)).toEqual([8]);
  });

  it("gives lastSavedAt null before the first check", async () => {
    const deps = await setup([check(CHILD2)]);
    const out = await storedPaymentsExport(deps);
    expect(out.lastSavedAt).toEqual({ [CHILD1]: null, [CHILD2]: NOW.toISOString() });
    expect((await storedPaymentsExport(deps, { childId: CHILD1 })).lastSavedAt).toEqual({ [CHILD1]: null });
  });

  it("returns the head state of a decided Payment", async () => {
    const first = payment(CHILD1, "2026-12", 5);
    const paid: NewJournalEvent = { ...first, seq: 2, eventType: "PaymentPaid", contentHash: "paid", payload: { ...first.payload, status: "paid", decidedBy: "1000001" } };
    const out = await storedPaymentsExport(await setup([first, paid]));
    expect(out.payments).toHaveLength(1);
    expect(out.payments[0]).toMatchObject({ seq: 2, eventType: "PaymentPaid", status: "paid", decidedBy: "1000001" });
  });

  it("never returns the forbidden fields", async () => {
    const out = await storedPaymentsExport(await setup([payment(CHILD1, "2026-12", 5)]));
    const text = JSON.stringify(out);
    for (const word of ["qr_payload", "account", "nip", "title", "recipient", "nrb", "sourceUrl", "61109010140000071219812874", "example.org"]) {
      expect(text).not.toContain(word);
    }
  });

  it("uses at most 3 fetches, all to Supabase", async () => {
    const deps = await setup([payment(CHILD1, "2026-12", 5), check(CHILD1)]);
    const out = await storedPaymentsExport(deps);
    expect(out.fetches).toBeDefined();
    const { total, hosts } = out.fetches!;
    expect(total).toBeLessThanOrEqual(3);
    expect(Object.keys(hosts)).toEqual(["project.example.test"]);
  });

  it("rejects bad input", async () => {
    const deps = await setup([]);
    await expect(storedPaymentsExport(deps, { month: "2026-13" })).rejects.toThrow("YYYY-MM");
    await expect(storedPaymentsExport(deps, { month: "2025-11" })).rejects.toThrow("12 months");
    await expect(storedPaymentsExport(deps, { month: "2025-12" })).resolves.toMatchObject({ month: "2025-12" });
    await expect(storedPaymentsExport(deps, { childId: "nope" })).rejects.toThrow("Unknown child");
    await expect(storedPaymentsExport(deps, { x: 1 })).rejects.toThrow("Unknown input");
  });

  it("gives the Journal child_id on each entry, also when the payload has none", async () => {
    const deps = await setup([payment(CHILD1, "2026-12", 5), payment(CHILD2, "2026-12", 6, { childId: undefined })]);
    const out = await storedPaymentsExport(deps);
    expect(out.payments.map((p) => [p.dueDay, p.childId])).toEqual([[5, CHILD1], [6, CHILD2]]);
  });
});

describe("storedPaymentsExport month range", () => {
  // Each month: its last day is in the export, the first day of the next month is not.
  it.each([
    ["2026-11", 30, "2026-12"],
    ["2027-02", 28, "2027-03"],
    ["2028-02", 29, "2028-03"],
    ["2026-12", 31, "2027-01"],
    ["2026-10", 31, "2026-11"],
  ])("reads %s with a half-open range of real days", async (month, lastDay, next) => {
    const deps = await setup([payment(CHILD1, month, 1), payment(CHILD1, month, lastDay), payment(CHILD1, next, 1)]);
    const out = await storedPaymentsExport(deps, { month });
    expect(out.payments.map((p) => `${p.month}/${p.dueDay}`)).toEqual([`${month}/1`, `${month}/${lastDay}`]);
  });

  it("defaults to November 2026 without a 400 (the reported bug)", async () => {
    const deps = await setup([payment(CHILD1, "2026-11", 30)], new Date("2026-11-10T03:07:00Z"));
    await expect(storedPaymentsExport(deps)).resolves.toMatchObject({ month: "2026-11", payments: [{ dueDay: 30 }] });
  });
});
