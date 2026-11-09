import { createMemoryStorage } from "@automations/librus-data";
import type { Fee, NewJournalEvent, StorageAdapter } from "@automations/librus-data";
import type { Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { runPayments } from "./engine.ts";
import type { FeeSource } from "./fee-source.ts";

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
  recipients: [{ id: "r1", family_id: FAMILY_ID, telegram_chat_id: "1000001", language: "en", child_ids: [CHILD1, CHILD2] }],
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
  sourceUrl: null,
  accountId: null,
  enabled: true,
};

function setup(fees: Fee[] = [fee]) {
  const memory = createMemoryStorage({ configs: [config] });
  fees.forEach((item) => memory.setFee(item));
  const appends: NewJournalEvent[][] = [];
  const storage: StorageAdapter = {
    ...memory,
    appendEvents: async (events) => {
      appends.push([...events]);
      return memory.appendEvents(events);
    },
  };
  let amount = 15050;
  const source: FeeSource = { amountFor: async (item, month) => ({ feeId: item.id, month, amount, source: "page" }) };
  const run = (now: string) => runPayments({ familyId: FAMILY_ID, storage, source, now: new Date(now) });
  const types = async () => (await memory.listEvents(FAMILY_ID)).map((event) => `${event.stream.split(":")[0]}:${event.eventType}`);
  return { memory, appends, run, types, setAmount: (value: number) => (amount = value) };
}

describe("runPayments Journal", () => {
  it("appends PaymentDue and CheckCompleted in the first pass", async () => {
    const { run, types } = setup();
    await run("2025-01-10T10:00:00Z");
    expect(await types()).toEqual(["check:CheckCompleted", "payment:PaymentDue"]);
  });

  it("appends only CheckCompleted when the amount is the same", async () => {
    const { run, types } = setup();
    await run("2025-01-10T10:00:00Z");
    await run("2025-01-11T10:00:00Z");
    expect(await types()).toEqual(["check:CheckCompleted", "check:CheckCompleted", "payment:PaymentDue"]);
  });

  it("appends PaymentChanged and updates the pending projection when the amount changes", async () => {
    const { memory, run, types, setAmount } = setup();
    await run("2025-01-10T10:00:00Z");
    setAmount(17000);
    await run("2025-01-11T10:00:00Z");
    expect(await types()).toContain("payment:PaymentChanged");
    expect((await memory.listPayments(FAMILY_ID))[0]).toMatchObject({ amount: 17000, amountSource: "page" });
    const queued = (await memory.pendingNotifications(FAMILY_ID)).map((entry) => entry.text);
    expect(queued).toHaveLength(1);
  });

  it("appends no PaymentChanged for a paid Payment and keeps its amount", async () => {
    const { memory, run, types, setAmount } = setup();
    await run("2025-01-10T10:00:00Z");
    const [payment] = await memory.listPayments(FAMILY_ID);
    await memory.setPaymentStatus(payment!.id, "paid", "1000001");
    setAmount(17000);
    await run("2025-01-11T10:00:00Z");
    expect(await types()).not.toContain("payment:PaymentChanged");
    expect((await memory.listPayments(FAMILY_ID))[0]).toMatchObject({ amount: 15050, status: "paid" });
  });

  it("makes one appendEvents call for a pass with many Fees", async () => {
    const other: Fee = { ...fee, id: "00000000-0000-4000-8000-0000000000f2", childId: CHILD2 };
    const { appends, run } = setup([fee, other]);
    await run("2025-01-10T10:00:00Z");
    expect(appends).toHaveLength(1);
    expect(appends[0]).toHaveLength(4);
  });

  it("appends a CheckCompleted for a Child with an enabled Fee that is not due", async () => {
    const { run, types } = setup([{ ...fee, notifyDay: 25 }]);
    await run("2025-01-10T10:00:00Z");
    expect(await types()).toEqual(["check:CheckCompleted"]);
  });

  it("appends no CheckCompleted for a Child with only a disabled Fee", async () => {
    const { appends, run } = setup([{ ...fee, enabled: false }]);
    await run("2025-01-10T10:00:00Z");
    expect(appends).toEqual([]);
  });

  it("appends the Payment events but no CheckCompleted when the pass fails", async () => {
    const second: Fee = { ...fee, id: "00000000-0000-4000-8000-0000000000f2" };
    const { memory, appends, run } = setup([fee, second]);
    const source: FeeSource = {
      amountFor: async (item, month) => {
        if (item.id === second.id) throw new Error("source failed");
        return { feeId: item.id, month, amount: 100, source: "config" };
      },
    };
    await expect(runPayments({ familyId: FAMILY_ID, storage: memory, source, now: new Date("2025-01-10T10:00:00Z") })).rejects.toThrow(
      "source failed",
    );
    expect(appends).toEqual([]);
    expect((await memory.listEvents(FAMILY_ID)).map((event) => event.eventType)).toEqual(["PaymentDue"]);
  });
});
