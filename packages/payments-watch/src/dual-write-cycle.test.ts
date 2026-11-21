import { comparePaymentsProjection, createMemoryStorage, projectionRows } from "@automations/librus-data";
import type { Fee } from "@automations/librus-data";
import { fakeRuntime, type Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { handlePaymentCallback } from "./callback.ts";
import type { FeeSource } from "./fee-source.ts";
import type { TelegramClient } from "./notifier.ts";
import { runPaymentsWatch } from "./run.ts";

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
  sourceUrl: null,
  accountId: null,
  enabled: true,
};

function setup() {
  const storage = createMemoryStorage({ configs: [config] });
  storage.setFee(fee);
  let amount = 15050;
  const source: FeeSource = { amountFor: async (item, month) => ({ feeId: item.id, month, amount, source: "page" }) };
  const messenger = { send: async () => undefined };
  const client: TelegramClient = { call: async () => undefined };
  const pass = (now: string) =>
    runPaymentsWatch({ runtime: fakeRuntime({ now: new Date(now) }), storage, messenger, familyId: FAMILY_ID, source });
  const decide = async (choice: "paid" | "skip") => {
    const [payment] = await storage.listPayments(FAMILY_ID);
    const query = { id: "q1", data: `pay:${payment!.id}:${choice}`, chatId: "1000001", messageId: 7, caption: "Caption" };
    return handlePaymentCallback({ familyId: FAMILY_ID, storage, client }, query);
  };
  const differences = async () =>
    comparePaymentsProjection(
      await storage.listHeads(FAMILY_ID, { kinds: ["payment"] }),
      projectionRows(await storage.listPayments(FAMILY_ID), [fee]),
    );
  const payment = async () => (await storage.listPayments(FAMILY_ID))[0];
  const types = async () => (await storage.listEvents(FAMILY_ID, { kinds: ["payment"] })).map((event) => event.eventType);
  return { pass, decide, differences, payment, types, storage, setAmount: (value: number) => (amount = value) };
}

async function runCycleUntilReminder(cycle: ReturnType<typeof setup>) {
  await cycle.pass("2026-12-10T08:00:00Z");
  expect(await cycle.payment()).toMatchObject({ month: "2026-12", amount: 15050, status: "pending" });
  expect((await cycle.payment())?.notifiedAt).not.toBeNull();
  expect(await cycle.differences()).toEqual([]);

  cycle.setAmount(16500);
  await cycle.pass("2026-12-12T08:00:00Z");
  expect(await cycle.payment()).toMatchObject({ amount: 16500, status: "pending" });
  expect(await cycle.differences()).toEqual([]);

  await cycle.pass("2026-12-14T08:00:00Z");
  expect((await cycle.payment())?.remindedAt).not.toBeNull();
  expect(await cycle.differences()).toEqual([]);
}

describe("December cycle: Journal and payments table stay the same", () => {
  it("notify, change, reminder, paid", async () => {
    const cycle = setup();
    await runCycleUntilReminder(cycle);
    expect(await cycle.decide("paid")).toBe(true);
    expect((await cycle.payment())?.status).toBe("paid");
    await cycle.pass("2026-12-16T08:00:00Z");
    expect(await cycle.differences()).toEqual([]);
    expect(await cycle.types()).toEqual(expect.arrayContaining(["PaymentDue", "PaymentChanged", "PaymentPaid"]));
  });

  it("notify, change, reminder, skip", async () => {
    const cycle = setup();
    await runCycleUntilReminder(cycle);
    expect(await cycle.decide("skip")).toBe(true);
    expect((await cycle.payment())?.status).toBe("skipped");
    await cycle.pass("2026-12-16T08:00:00Z");
    expect(await cycle.differences()).toEqual([]);
  });

  it("finds a difference when only the payments table changes", async () => {
    const cycle = setup();
    await cycle.pass("2026-12-10T08:00:00Z");
    const payment = await cycle.payment();
    await cycle.storage.setPaymentStatus(payment!.id, "paid", "1000001");
    expect(await cycle.differences()).toEqual([
      { stream: `payment:${CHILD1}:${fee.id}:2026-12`, paymentId: payment!.id, problem: "mismatch", field: "status" },
    ]);
  });
});
