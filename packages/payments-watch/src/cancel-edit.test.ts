import { createMemoryStorage, paymentStream, planPaymentCancelled, type Fee } from "@automations/librus-data";
import { fakeRuntime, type Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { createConfigFeeSource } from "./fee-source.ts";
import type { Notifier, TelegramClient, TelegramParams } from "./notifier.ts";
import { runPaymentsWatch } from "./run.ts";

// Issue #221: edit the sent QR message when a Payment is cancelled (payments contract v0.2 section 3b, PC4).
const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
const CHILD1 = "00000000-0000-4000-8000-0000000000c1";

const config: Config = {
  family: { id: FAMILY_ID, name: "Example Family", timezone: "Europe/Warsaw", default_language: "en" },
  children: [{ id: CHILD1, family_id: FAMILY_ID, name: "Child One", has_librus: true, calendar_id: null }],
  accounts: [],
  activities: [],
  recipients: [
    { id: "r1", family_id: FAMILY_ID, telegram_chat_id: "1000001", language: "en", child_ids: [CHILD1] },
    { id: "r2", family_id: FAMILY_ID, telegram_chat_id: "1000002", language: "pl", child_ids: [CHILD1] },
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
  amounts: { "2026-01": 15050 },
  sourceUrl: null,
  accountId: null,
  enabled: true,
};

interface Call {
  method: string;
  params: TelegramParams;
}

function setup(options: { withMessageIds?: boolean; failEdit?: boolean } = {}) {
  const { withMessageIds = true, failEdit = false } = options;
  const storage = createMemoryStorage({ configs: [config] });
  storage.setFee(fee);
  const texts: string[] = [];
  const messenger = { send: async (chatId: string, text: string) => void texts.push(`${chatId}|${text}`) };
  const calls: Call[] = [];
  const client: TelegramClient = {
    async call(method, params) {
      calls.push({ method, params });
      if (failEdit) throw new Error("Telegram editMessageCaption failed with status 400");
    },
  };
  let next = 500;
  const notifier: Notifier = { sendPayment: async () => (withMessageIds ? next++ : undefined) };
  const at = (now: string) => ({ runtime: fakeRuntime({ now: new Date(now) }), storage, messenger, familyId: FAMILY_ID, source: createConfigFeeSource(), notifier, client });
  const run = (now: string) => runPaymentsWatch(at(now));
  const cancelWith = async (reason: "organizer_void" | "organizer_withdrawn") => {
    const [payment] = await storage.listPayments(FAMILY_ID);
    const stream = paymentStream(CHILD1, fee.id, payment!.month);
    const head = (await storage.listHeads(FAMILY_ID, { kinds: ["payment"] })).find((event) => event.stream === stream)!;
    await storage.appendEvents([(await planPaymentCancelled(head, reason, new Date("2026-01-13T08:00:00Z")))!]);
    await storage.cancelPendingPayment(payment!.id);
  };
  const edits = () => calls.filter((call) => call.method === "editMessageCaption");
  return { storage, run, cancelWith, calls, edits, texts };
}

describe("cancel edit", () => {
  it("stores the message ID of each sent QR message", async () => {
    const { storage, run } = setup();
    await run("2026-01-12T08:00:00Z");
    const sent = await storage.sentMessages(FAMILY_ID);
    expect(sent.map((entry) => [entry.chatId, entry.messageId])).toEqual([["1000001", 500], ["1000002", 501]]);
  });

  it("edits each stored QR message on fee_disabled: new caption, no buttons, no new message", async () => {
    const { storage, run, edits, texts } = setup();
    await run("2026-01-12T08:00:00Z");
    texts.length = 0;
    storage.setFee({ ...fee, enabled: false });
    expect(await run("2026-01-13T08:00:00Z")).toEqual([]);
    expect(edits().map((call) => call.params)).toEqual([
      { chat_id: "1000001", message_id: 500, caption: "CANCELLED, do not pay.\nReason: the Fee is turned off", reply_markup: { inline_keyboard: [] } },
      { chat_id: "1000002", message_id: 501, caption: "ANULOWANE, nie płać.\nPowód: opłata jest wyłączona", reply_markup: { inline_keyboard: [] } },
    ]);
    expect(texts).toEqual([]);
  });

  it.each(["organizer_void", "organizer_withdrawn"] as const)("edits and sends exactly one new message to each Recipient on %s", async (reason) => {
    const { run, cancelWith, edits, texts } = setup();
    await run("2026-01-12T08:00:00Z");
    texts.length = 0;
    await cancelWith(reason);
    await run("2026-01-13T08:00:00Z");
    expect(edits()).toHaveLength(2);
    expect(String(edits()[0]!.params.caption)).toContain("CANCELLED, do not pay.");
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("1000001|Payment cancelled: Child One, Example Organizer, 2026-01");
    expect(texts[1]).toContain("1000002|Płatność anulowana:");
  });

  it("edits the first notice and the reminder, and does nothing in a second run", async () => {
    const { storage, run, cancelWith, edits, texts, calls } = setup();
    await run("2026-01-12T08:00:00Z");
    await run("2026-01-15T08:00:00Z");
    expect((await storage.sentMessages(FAMILY_ID)).length).toBe(4);
    texts.length = 0;
    await cancelWith("organizer_void");
    await run("2026-01-16T08:00:00Z");
    expect(edits().map((call) => call.params.message_id).sort()).toEqual([500, 501, 502, 503]);
    expect(edits()).toHaveLength(4);
    const before = [calls.length, texts.length];
    await run("2026-01-17T08:00:00Z");
    expect([calls.length, texts.length]).toEqual(before);
  });

  it("gives no edit and no error for a Payment with no stored message ID", async () => {
    const { run, cancelWith, calls, texts } = setup({ withMessageIds: false });
    await run("2026-01-12T08:00:00Z");
    texts.length = 0;
    await cancelWith("organizer_void");
    expect(await run("2026-01-13T08:00:00Z")).toEqual([]);
    expect(calls).toEqual([]);
    expect(texts).toEqual([]);
  });

  it("logs a failed edit (Telegram 400), keeps the cancel and does not edit again", async () => {
    const { storage, run, cancelWith, edits } = setup({ failEdit: true });
    await run("2026-01-12T08:00:00Z");
    await cancelWith("organizer_void");
    expect(await run("2026-01-13T08:00:00Z")).toEqual([]);
    expect(edits()).toHaveLength(2);
    expect((await storage.listPayments(FAMILY_ID))[0]!.status).toBe("cancelled");
    await run("2026-01-14T08:00:00Z");
    expect(edits()).toHaveLength(2);
  });
});
