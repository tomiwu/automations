import { createMemoryStorage } from "@automations/librus-data";
import type { Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { handleTelegramUpdate, type UpdateDeps } from "./telegram-update.ts";
import type { TelegramParams } from "./notifier.ts";

const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
const CHILD1 = "00000000-0000-4000-8000-0000000000c1";
const FEE_ID = "00000000-0000-4000-8000-0000000000f1";
const config: Config = {
  family: { id: FAMILY_ID, name: "Example Family", timezone: "Europe/Warsaw", default_language: "en" },
  children: [{ id: CHILD1, family_id: FAMILY_ID, name: "Child One", has_librus: true, calendar_id: null }],
  accounts: [],
  activities: [],
  recipients: [{ id: "r1", family_id: FAMILY_ID, telegram_chat_id: "1000001", language: "en", child_ids: [CHILD1] }],
};

async function setup() {
  const storage = createMemoryStorage({ configs: [config] });
  storage.setFee({
    id: FEE_ID,
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
  });
  const payment = await storage.upsertPayment({ familyId: FAMILY_ID, feeId: FEE_ID, month: "2026-01", amount: 15050, amountSource: "config" });
  const calls: Array<{ method: string; params: TelegramParams }> = [];
  const logs: string[] = [];
  const deps: UpdateDeps = {
    callback: { familyId: FAMILY_ID, storage, client: { call: async (method, params) => void calls.push({ method, params }) } },
    log: (message) => logs.push(message),
  };
  return { storage, deps, calls, logs, paymentId: payment.id };
}

const press = (data: string, extra: Record<string, unknown> = {}) => ({
  update_id: 1,
  callback_query: {
    id: "cb1",
    data,
    message: { message_id: 7, caption: "Example caption", chat: { id: 1000001 } },
    ...extra,
  },
});

describe("handleTelegramUpdate", () => {
  it("sets the Payment to paid", async () => {
    const { storage, deps, calls, paymentId } = await setup();
    await handleTelegramUpdate(deps, press(`pay:${paymentId}:paid`));
    expect((await storage.listPayments(FAMILY_ID))[0]?.status).toBe("paid");
    expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery", "editMessageCaption"]);
    expect(calls[1]?.params).toMatchObject({ chat_id: "1000001", message_id: 7 });
    expect(String(calls[1]?.params.caption)).toContain("Example caption");
  });

  it("sets the Payment to skipped", async () => {
    const { storage, deps, paymentId } = await setup();
    await handleTelegramUpdate(deps, press(`pay:${paymentId}:skip`));
    expect((await storage.listPayments(FAMILY_ID))[0]?.status).toBe("skipped");
  });

  it("reads the webhook envelope", async () => {
    const { storage, deps, paymentId } = await setup();
    await handleTelegramUpdate(deps, { webhook: "telegram-update", request: { json: press(`pay:${paymentId}:paid`) } });
    expect((await storage.listPayments(FAMILY_ID))[0]?.status).toBe("paid");
  });

  it("logs a callback that is not a payment callback", async () => {
    const { deps, calls, logs } = await setup();
    await handleTelegramUpdate(deps, press("other:1"));
    expect(calls).toEqual([]);
    expect(logs).toHaveLength(1);
  });

  it("logs an update without callback_query", async () => {
    const { deps, calls, logs } = await setup();
    await handleTelegramUpdate(deps, { update_id: 2, message: { text: "hello" } });
    expect(calls).toEqual([]);
    expect(logs).toHaveLength(1);
  });

  it("logs input that is not an object", async () => {
    const { deps, logs } = await setup();
    await handleTelegramUpdate(deps, "text");
    await handleTelegramUpdate(deps, { request: null });
    expect(logs).toHaveLength(2);
  });

  it("changes nothing for a payment callback without a message", async () => {
    const { storage, deps, calls, logs, paymentId } = await setup();
    await handleTelegramUpdate(deps, { update_id: 3, callback_query: { id: "cb2", data: `pay:${paymentId}:paid` } });
    expect((await storage.listPayments(FAMILY_ID))[0]?.status).toBe("pending");
    expect(calls).toEqual([]);
    expect(logs).toHaveLength(1);
  });

  it("changes nothing when the message has no valid chat", async () => {
    const { storage, deps, logs, paymentId } = await setup();
    const update = press(`pay:${paymentId}:paid`, { message: { message_id: 7, chat: {} } });
    await handleTelegramUpdate(deps, update);
    expect((await storage.listPayments(FAMILY_ID))[0]?.status).toBe("pending");
    expect(logs).toHaveLength(1);
  });

  it("works without a caption", async () => {
    const { deps, calls, paymentId } = await setup();
    await handleTelegramUpdate(deps, press(`pay:${paymentId}:paid`, { message: { message_id: 7, chat: { id: 1000001 } } }));
    expect(calls[1]?.params.caption).toBeTypeOf("string");
  });
});
