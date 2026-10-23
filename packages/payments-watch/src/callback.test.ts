import { createMemoryStorage } from "@automations/librus-data";
import type { Fee } from "@automations/librus-data";
import type { Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { handlePaymentCallback, type CallbackQuery } from "./callback.ts";
import type { TelegramClient, TelegramParams } from "./notifier.ts";

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
    { id: "r1", family_id: FAMILY_ID, telegram_chat_id: "1000001", language: "en", child_ids: [CHILD1] },
    { id: "r2", family_id: FAMILY_ID, telegram_chat_id: "1000002", language: "pl", child_ids: [CHILD2] },
  ],
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
  amounts: { "2025-02": 15050 },
  sourceUrl: null,
  accountId: null,
  enabled: true,
};

async function setup() {
  const storage = createMemoryStorage({ configs: [config] });
  storage.setFee(fee);
  const payment = await storage.upsertPayment({
    familyId: FAMILY_ID,
    feeId: fee.id,
    month: "2025-02",
    amount: 15050,
    amountSource: "config",
  });
  const calls: Array<{ method: string; params: TelegramParams }> = [];
  const client: TelegramClient = {
    async call(method, params) {
      calls.push({ method, params });
    },
  };
  const handle = (query: Partial<CallbackQuery>) =>
    handlePaymentCallback(
      { familyId: FAMILY_ID, storage, client },
      { id: "q1", data: `pay:${payment.id}:paid`, chatId: "1000001", messageId: 7, caption: "Caption", ...query },
    );
  const status = async () => (await storage.listPayments(FAMILY_ID))[0];
  return { payment, calls, handle, status };
}

describe("handlePaymentCallback", () => {
  it("does not handle data without the pay: prefix", async () => {
    const { handle, calls } = await setup();
    expect(await handle({ data: "other:1" })).toBe(false);
    expect(calls).toEqual([]);
  });

  it("marks the Payment as paid for a Recipient of the Child, edits the message and removes the buttons", async () => {
    const { handle, calls, status } = await setup();
    expect(await handle({})).toBe(true);
    expect(await status()).toMatchObject({ status: "paid", decidedBy: "1000001" });
    expect(calls.map((call) => call.method)).toEqual(["answerCallbackQuery", "editMessageCaption"]);
    expect(calls[1]?.params).toEqual({
      chat_id: "1000001",
      message_id: 7,
      caption: "Caption\nStatus: paid",
      reply_markup: { inline_keyboard: [] },
    });
  });

  it("marks the Payment as skipped", async () => {
    const { handle, payment, status } = await setup();
    await handle({ data: `pay:${payment.id}:skip` });
    expect((await status())?.status).toBe("skipped");
  });

  it("gives an error answer and changes nothing for a chat that is not a Recipient of the Child", async () => {
    const { handle, calls, status } = await setup();
    await handle({ chatId: "1000002" });
    expect((await status())?.status).toBe("pending");
    expect(calls).toEqual([
      { method: "answerCallbackQuery", params: { callback_query_id: "q1", text: "Nie możesz zmienić tej płatności.", show_alert: true } },
    ]);
  });

  it("gives an error answer for a chat that is not a Recipient", async () => {
    const { handle, calls, status } = await setup();
    await handle({ chatId: "1999999" });
    expect((await status())?.status).toBe("pending");
    expect(calls[0]?.params).toMatchObject({ text: "You cannot change this Payment.", show_alert: true });
  });

  it("does not change the status on a second press", async () => {
    const { handle, calls, payment, status } = await setup();
    await handle({});
    calls.length = 0;
    await handle({ data: `pay:${payment.id}:skip` });
    expect(await status()).toMatchObject({ status: "paid", decidedBy: "1000001" });
    expect(calls).toEqual([
      { method: "answerCallbackQuery", params: { callback_query_id: "q1", text: "This Payment has a status already.", show_alert: true } },
    ]);
  });

  it("answers with an error for an unknown Payment or a bad action", async () => {
    const { handle, calls, payment, status } = await setup();
    await handle({ data: "pay:missing:paid" });
    await handle({ data: `pay:${payment.id}:other` });
    expect((await status())?.status).toBe("pending");
    expect(calls.map((call) => call.params.text)).toEqual(["This Payment does not exist.", "This Payment does not exist."]);
  });

  it("edits only the status line when the message has no caption", async () => {
    const { handle, calls } = await setup();
    await handle({ caption: undefined });
    expect(calls[1]?.params).toMatchObject({ caption: "Status: paid" });
  });
});
