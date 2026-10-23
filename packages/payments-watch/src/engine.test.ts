import { createMemoryStorage } from "@automations/librus-data";
import type { Fee } from "@automations/librus-data";
import type { Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { formatAmount, runPayments } from "./engine.ts";
import { createConfigFeeSource } from "./fee-source.ts";

const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
const CHILD1 = "00000000-0000-4000-8000-0000000000c1";
const CHILD2 = "00000000-0000-4000-8000-0000000000c2";

const config: Config = {
  family: { id: FAMILY_ID, name: "Example Family", timezone: "Europe/Warsaw", default_language: "en" },
  children: [
    { id: CHILD1, family_id: FAMILY_ID, name: "Child One", has_librus: true, calendar_id: null },
    { id: CHILD2, family_id: FAMILY_ID, name: "Child Two", has_librus: true, calendar_id: null },
  ],
  accounts: [],
  activities: [],
  recipients: [
    { id: "r1", family_id: FAMILY_ID, telegram_chat_id: "1000001", language: "en", child_ids: [CHILD1, CHILD2] },
    { id: "r2", family_id: FAMILY_ID, telegram_chat_id: "1000002", language: "pl", child_ids: [CHILD1] },
  ],
};

const fee: Fee = {
  id: "00000000-0000-4000-8000-0000000000f1",
  familyId: FAMILY_ID,
  childId: CHILD2,
  organizer: "Example Organizer",
  recipientName: "Example Recipient",
  nip: null,
  account: "61109010140000071219812874",
  title: "Example fee",
  dueDay: 20,
  notifyDay: 10,
  reminderDay: 14,
  amounts: { "2025-01": 15050, "2025-02": 20000, "2025-03": 0 },
  sourceUrl: null,
  accountId: null,
  enabled: true,
};

function setup(override: Partial<Fee> = {}) {
  const storage = createMemoryStorage({ configs: [config] });
  storage.setFee({ ...fee, ...override });
  const run = (now: string) =>
    runPayments({ familyId: FAMILY_ID, storage, source: createConfigFeeSource(), now: new Date(now) });
  const outbox = async () => (await storage.pendingNotifications(FAMILY_ID)).map((e) => `${e.key}|${e.text}`);
  return { storage, run, outbox };
}

describe("formatAmount", () => {
  it("formats grosze", () => {
    expect(formatAmount(15050)).toBe("150.50");
    expect(formatAmount(5)).toBe("0.05");
  });
});

describe("runPayments", () => {
  it("makes nothing before notify_day", async () => {
    const { storage, run, outbox } = setup();
    await run("2025-01-09T10:00:00Z");
    expect(await storage.listPayments(FAMILY_ID)).toEqual([]);
    expect(await outbox()).toEqual([]);
  });

  it("makes a pending Payment and one Notification for each Recipient of the Child on notify_day", async () => {
    const { storage, run, outbox } = setup({ childId: CHILD1 });
    await run("2025-01-10T10:00:00Z");
    const [payment] = await storage.listPayments(FAMILY_ID);
    expect(payment).toMatchObject({ status: "pending", amount: 15050, month: "2025-01", amountSource: "config" });
    expect(await outbox()).toEqual([
      `payment:${payment!.id}:1000001|Payment for Child One: Example Organizer, 2025-01, 150.50 PLN, due 2025-01-20`,
      `payment:${payment!.id}:1000002|Płatność dla Child One: Example Organizer, 2025-01, 150.50 PLN, termin 2025-01-20`,
    ]);
  });

  it("skips a Recipient that has not the Child", async () => {
    const { storage, run, outbox } = setup();
    await run("2025-01-10T10:00:00Z");
    const [payment] = await storage.listPayments(FAMILY_ID);
    expect(await outbox()).toEqual([expect.stringContaining(`payment:${payment!.id}:1000001|`)]);
  });

  it("does not repeat anything in a repeated run", async () => {
    const { storage, run, outbox } = setup();
    await run("2025-01-10T10:00:00Z");
    await run("2025-01-10T12:00:00Z");
    await run("2025-01-11T10:00:00Z");
    expect(await storage.listPayments(FAMILY_ID)).toHaveLength(1);
    expect(await outbox()).toHaveLength(1);
  });

  it("queues one reminder on reminder_day for a pending Payment", async () => {
    const { run, outbox } = setup();
    await run("2025-01-10T10:00:00Z");
    await run("2025-01-14T10:00:00Z");
    await run("2025-01-15T10:00:00Z");
    const entries = await outbox();
    expect(entries).toHaveLength(2);
    expect(entries[1]).toContain(":reminder|Reminder. Not paid yet for Child Two");
  });

  it("queues nothing more for a paid Payment", async () => {
    const { storage, run, outbox } = setup();
    await run("2025-01-10T10:00:00Z");
    const [payment] = await storage.listPayments(FAMILY_ID);
    await storage.setPaymentStatus(payment!.id, "paid", "1000001");
    await run("2025-01-14T10:00:00Z");
    expect(await outbox()).toHaveLength(1);
  });

  it("queues nothing more for a skipped Payment", async () => {
    const { storage, run, outbox } = setup();
    await run("2025-01-10T10:00:00Z");
    const [payment] = await storage.listPayments(FAMILY_ID);
    await storage.setPaymentStatus(payment!.id, "skipped", "1000001");
    await run("2025-01-20T10:00:00Z");
    expect(await outbox()).toHaveLength(1);
  });

  it("makes a new Payment in the next month", async () => {
    const { storage, run, outbox } = setup();
    await run("2025-01-10T10:00:00Z");
    await run("2025-02-10T10:00:00Z");
    expect((await storage.listPayments(FAMILY_ID)).map((p) => p.month)).toEqual(["2025-01", "2025-02"]);
    expect(await outbox()).toHaveLength(2);
  });

  it("uses the day in the Family time zone", async () => {
    const { storage, run } = setup();
    await run("2025-01-09T23:30:00Z");
    expect(await storage.listPayments(FAMILY_ID)).toHaveLength(1);
  });

  it("uses the month in the Family time zone at a month change", async () => {
    const { storage, run } = setup({ notifyDay: 1, dueDay: 5, reminderDay: 10 });
    await run("2025-01-31T23:30:00Z");
    expect((await storage.listPayments(FAMILY_ID)).map((p) => p.month)).toEqual(["2025-02"]);
  });

  it("makes no Payment for an amount of 0, no amount or a disabled Fee", async () => {
    const zero = setup();
    await zero.run("2025-03-12T10:00:00Z");
    await zero.run("2025-04-12T10:00:00Z");
    expect(await zero.storage.listPayments(FAMILY_ID)).toEqual([]);
    const off = setup({ enabled: false });
    await off.run("2025-01-12T10:00:00Z");
    expect(await off.storage.listPayments(FAMILY_ID)).toEqual([]);
  });

  it("makes the Payment but queues nothing when the Child is not in the config", async () => {
    const { storage, run, outbox } = setup({ childId: "00000000-0000-4000-8000-0000000000c9" });
    await run("2025-01-10T10:00:00Z");
    expect(await storage.listPayments(FAMILY_ID)).toHaveLength(1);
    expect(await outbox()).toEqual([]);
  });
});
