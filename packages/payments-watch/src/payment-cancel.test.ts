import { createMemoryStorage } from "@automations/librus-data";
import type { Fee } from "@automations/librus-data";
import type { Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { handlePaymentCallback } from "./callback.ts";
import { buildDashboard } from "./dashboard-data.ts";
import { runPayments } from "./engine.ts";
import type { FeeSource } from "./fee-source.ts";
import type { TelegramClient, TelegramParams } from "./notifier.ts";

const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
const CHILD1 = "00000000-0000-4000-8000-0000000000c1";
const CHILD2 = "00000000-0000-4000-8000-0000000000c2";

const config: Config = {
  family: { id: FAMILY_ID, name: "Example Family", timezone: "Europe/Warsaw", default_language: "en" },
  children: [
    { id: CHILD1, family_id: FAMILY_ID, name: "Child One", has_librus: true, calendar_id: null },
    { id: CHILD2, family_id: FAMILY_ID, name: "Child Two", has_librus: false, calendar_id: null },
  ],
  accounts: [],
  activities: [],
  recipients: [
    { id: "r1", family_id: FAMILY_ID, telegram_chat_id: "1000001", language: "en", child_ids: [CHILD1] },
    { id: "r2", family_id: FAMILY_ID, telegram_chat_id: "1000002", language: "pl", child_ids: [CHILD2] },
  ],
};

const fee = (id: string, childId: string): Fee => ({
  id,
  familyId: FAMILY_ID,
  childId,
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
});

const FEE1 = fee("00000000-0000-4000-8000-0000000000f1", CHILD1);
const FEE2 = fee("00000000-0000-4000-8000-0000000000f2", CHILD2);

function setup() {
  const storage = createMemoryStorage({ configs: [config] });
  storage.setFee(FEE1);
  storage.setFee(FEE2);
  const source: FeeSource = { amountFor: async (item, month) => ({ feeId: item.id, month, amount: 15050, source: "config" }) };
  const run = (now: string) => runPayments({ familyId: FAMILY_ID, storage, source, now: new Date(now) });
  const types = async () => (await storage.listEvents(FAMILY_ID, { kinds: ["payment"] })).map((e) => `${e.stream.split(":")[2]?.slice(-2)}:${e.eventType}`);
  const paymentOf = async (feeId: string) => (await storage.listPayments(FAMILY_ID)).find((p) => p.feeId === feeId)!;
  const calls: Array<{ method: string; params: TelegramParams }> = [];
  const client: TelegramClient = { call: async (method, params) => void calls.push({ method, params }) };
  const press = async (feeId: string, chatId: string, action = "paid") => {
    const payment = await paymentOf(feeId);
    return handlePaymentCallback({ familyId: FAMILY_ID, storage, client }, { id: "q1", data: `pay:${payment.id}:${action}`, chatId, messageId: 7, caption: "Caption" });
  };
  return { storage, run, types, paymentOf, press, calls };
}

describe("PaymentCancelled for a disabled Fee", () => {
  it("cancels the pending Payment of the month once, with fee_disabled, and queues no reminder", async () => {
    const { storage, run, types, paymentOf } = setup();
    await run("2026-12-10T08:00:00Z");
    storage.setFee({ ...FEE1, enabled: false });
    await run("2026-12-12T08:00:00Z");
    expect((await paymentOf(FEE1.id)).status).toBe("cancelled");
    expect((await paymentOf(FEE2.id)).status).toBe("pending");
    const cancels = (await storage.listEvents(FAMILY_ID, { kinds: ["payment"] })).filter((e) => e.eventType === "PaymentCancelled");
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.payload).toMatchObject({ status: "cancelled", cancelReason: "fee_disabled", amount: 15050, decidedAt: null });
    const before = (await types()).length;
    await run("2026-12-14T08:00:00Z");
    expect((await types()).length).toBe(before);
    const queued = (await storage.pendingNotifications(FAMILY_ID)).map((entry) => entry.key);
    const payment1 = await paymentOf(FEE1.id);
    expect(queued.some((key) => key.startsWith(`payment:${payment1.id}:`) && key.endsWith(":reminder"))).toBe(false);
  });

  it("does not cancel a paid or skipped Payment", async () => {
    const { storage, run, paymentOf } = setup();
    await run("2026-12-10T08:00:00Z");
    await storage.setPaymentStatus((await paymentOf(FEE1.id)).id, "paid", "1000001");
    await storage.setPaymentStatus((await paymentOf(FEE2.id)).id, "skipped", "1000002");
    storage.setFee({ ...FEE1, enabled: false });
    storage.setFee({ ...FEE2, enabled: false });
    await run("2026-12-12T08:00:00Z");
    expect([(await paymentOf(FEE1.id)).status, (await paymentOf(FEE2.id)).status]).toEqual(["paid", "skipped"]);
    const types = (await storage.listEvents(FAMILY_ID, { kinds: ["payment"] })).map((e) => e.eventType);
    expect(types).not.toContain("PaymentCancelled");
  });

  it("cancels a pending Payment that has no Journal head yet (PaymentDue first)", async () => {
    const { storage, run, paymentOf } = setup();
    await storage.upsertPayment({ familyId: FAMILY_ID, feeId: FEE1.id, month: "2026-12", amount: 15050, amountSource: "config" });
    storage.setFee({ ...FEE1, enabled: false });
    await run("2026-12-12T08:00:00Z");
    expect((await paymentOf(FEE1.id)).status).toBe("cancelled");
    const types = (await storage.listEvents(FAMILY_ID, { kinds: ["payment"] })).filter((e) => e.stream.includes(FEE1.id)).map((e) => e.eventType);
    expect(types).toEqual(["PaymentDue", "PaymentCancelled"]);
  });
});

describe("Paid and Skip on a cancelled Payment", () => {
  it.each([
    [FEE1.id, "1000001", "This Payment is cancelled. Do not pay it."],
    [FEE2.id, "1000002", "Ta płatność jest anulowana. Nie płać jej."],
  ])("change nothing and answer in the language of the Recipient (%s)", async (feeId, chatId, text) => {
    const { storage, run, paymentOf, press, calls } = setup();
    await run("2026-12-10T08:00:00Z");
    storage.setFee({ ...FEE1, enabled: false });
    storage.setFee({ ...FEE2, enabled: false });
    await run("2026-12-12T08:00:00Z");
    const before = (await storage.listEvents(FAMILY_ID)).length;
    expect(await press(feeId, chatId)).toBe(true);
    expect(await press(feeId, chatId, "skip")).toBe(true);
    expect((await paymentOf(feeId)).status).toBe("cancelled");
    expect((await storage.listEvents(FAMILY_ID)).length).toBe(before);
    expect(calls.map((call) => [call.method, call.params.text])).toEqual([
      ["answerCallbackQuery", text],
      ["answerCallbackQuery", text],
    ]);
  });
});

describe("Dashboard", () => {
  it("shows a cancelled Payment in history only: not in next due and not in spend", async () => {
    const { storage, run } = setup();
    await run("2026-12-10T08:00:00Z");
    storage.setFee({ ...FEE1, enabled: false });
    await run("2026-12-12T08:00:00Z");
    const view = buildDashboard({ children: config.children, fees: [FEE1, FEE2], payments: await storage.listPayments(FAMILY_ID), today: "2026-12-12" });
    expect(view.cancelled.map((row) => row.status)).toEqual(["cancelled"]);
    expect(view.nextDue).toHaveLength(1);
    expect(view.spendByMonth).toEqual([]);
  });
});
