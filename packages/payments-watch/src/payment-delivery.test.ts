import { createMemoryStorage, type Fee } from "@automations/librus-data";
import { fakeRuntime, type Config } from "@automations/shared";
import jsQR from "jsqr";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import type { FeeSource } from "./fee-source.ts";
import { createTelegramHttpClient, createTelegramNotifier } from "./notifier.ts";
import { deliverPaymentPhotos, isPaymentKey, withoutPaymentEntries } from "./payment-delivery.ts";
import { runPaymentsWatch } from "./run.ts";

const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
const CHILD1 = "00000000-0000-4000-8000-0000000000c1";
const FAKE_BOT_TOKEN = "123456:FAKE-bot-token";

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
  sourceUrl: "https://organizer.example.com/fees",
  accountId: null,
  enabled: true,
};

const pageSource: FeeSource = {
  amountFor: async (f, month) => ({ feeId: f.id, month, amount: 16000, source: "page", configAmount: 15050 }),
};

interface Sent {
  chatId: string;
  caption: string;
  buttons: string[];
  qr: string;
}

function fakeTelegram(failChat?: string) {
  const photos: Sent[] = [];
  const urls: string[] = [];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    urls.push(url);
    const form = init?.body as FormData;
    const chatId = String(form.get("chat_id"));
    if (chatId === failChat) return new Response("down", { status: 502 });
    const png = PNG.sync.read(Buffer.from(await (form.get("photo") as Blob).arrayBuffer()));
    const markup = JSON.parse(String(form.get("reply_markup"))) as { inline_keyboard: { callback_data: string }[][] };
    photos.push({
      chatId,
      caption: String(form.get("caption")),
      buttons: markup.inline_keyboard.flat().map((b) => b.callback_data),
      qr: jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data ?? "",
    });
    return new Response("{}");
  };
  return { photos, urls, notifier: createTelegramNotifier(createTelegramHttpClient(fetchFn, FAKE_BOT_TOKEN)) };
}

function setup(now: string, failChat?: string) {
  const storage = createMemoryStorage({ configs: [config] });
  storage.setFee(fee);
  const texts: string[] = [];
  const messenger = { send: async (chatId: string, text: string) => void texts.push(`${chatId}|${text}`) };
  const runtime = fakeRuntime({ now: new Date(now) });
  const telegram = fakeTelegram(failChat);
  const deps = { runtime, storage, messenger, familyId: FAMILY_ID, source: pageSource, notifier: telegram.notifier };
  return { deps, storage, texts, telegram };
}

describe("Payment photos (reminder = QR photo again)", () => {
  it("sends the reminder as sendPhoto with Paid/Skip, a reminder marker and the page amount in the QR", async () => {
    const { deps, telegram, texts, storage } = setup("2026-01-15T08:00:00Z");
    expect(await runPaymentsWatch(deps)).toEqual([]);
    expect(texts).toEqual([]);
    expect(telegram.urls.every((url) => url.endsWith("/sendPhoto"))).toBe(true);
    const reminders = telegram.photos.filter((p) => /Reminder|Przypomnienie/.test(p.caption));
    expect(reminders.map((p) => p.chatId).sort()).toEqual(["1000001", "1000002"]);
    const en = reminders.find((p) => p.chatId === "1000001")!;
    expect(en.caption.split("\n")[0]).toBe("Reminder: not paid yet.");
    expect(en.caption).toContain("The page shows 160.00 PLN. The config shows 150.50 PLN.");
    expect(reminders.find((p) => p.chatId === "1000002")!.caption.split("\n")[0]).toBe("Przypomnienie: brak wpłaty.");
    const [payment] = await storage.listPayments(FAMILY_ID);
    expect(en.buttons).toEqual([`pay:${payment!.id}:paid`, `pay:${payment!.id}:skip`]);
    expect(en.qr).toBe("|PL|61109010140000071219812874|016000|Example Recipient|Example fee|||");
    const first = telegram.photos.filter((p) => !/Reminder|Przypomnienie/.test(p.caption));
    expect(first).toHaveLength(2);
    expect(payment!.remindedAt).not.toBeNull();
    expect(payment!.notifiedAt).not.toBeNull();
  });

  it("does not send when the Payment is paid or skipped", async () => {
    const { deps, storage, telegram } = setup("2026-01-12T08:00:00Z");
    await runPaymentsWatch({ ...deps, notifier: undefined, messenger: { send: async () => Promise.reject(new Error("offline")) } });
    const [payment] = await storage.listPayments(FAMILY_ID);
    await storage.setPaymentStatus(payment!.id, "paid", "1000001");
    const result = await deliverPaymentPhotos({ storage, familyId: FAMILY_ID, notifier: telegram.notifier });
    expect(result).toEqual({ sent: [] });
    expect(telegram.photos).toEqual([]);
    expect(await storage.pendingNotifications(FAMILY_ID)).toEqual([]);
  });

  it("does not send a reminder when remindedAt is set already", async () => {
    const { deps, storage, telegram } = setup("2026-01-15T08:00:00Z");
    await runPaymentsWatch({ ...deps, notifier: undefined, messenger: { send: async () => Promise.reject(new Error("offline")) } });
    const [payment] = await storage.listPayments(FAMILY_ID);
    await storage.markPaymentSent(payment!.id, "reminded", new Date("2026-01-15T07:00:00Z"));
    const logs: string[] = [];
    const result = await deliverPaymentPhotos({ storage, familyId: FAMILY_ID, notifier: telegram.notifier, log: (m) => logs.push(m) });
    expect(result.sent.every((key) => !key.endsWith(":reminder"))).toBe(true);
    expect(telegram.photos.some((p) => p.caption.startsWith("Reminder"))).toBe(false);
    expect(logs.some((line) => line.includes("reminder sent already"))).toBe(true);
  });

  it("keeps the entries of a failed chat and returns the failure, the other chat still gets its photos", async () => {
    const { deps, storage, telegram } = setup("2026-01-12T08:00:00Z", "1000002");
    const failures = await runPaymentsWatch(deps);
    expect(failures).toEqual(["photos: Telegram sendPhoto failed with status 502"]);
    expect(failures.join(" ")).not.toContain(FAKE_BOT_TOKEN);
    expect(telegram.photos.map((p) => p.chatId)).toEqual(["1000001"]);
    expect((await storage.pendingNotifications(FAMILY_ID)).map((e) => e.chatId)).toEqual(["1000002"]);
  });

  it("without a Notifier keeps the old text path", async () => {
    const { deps, texts, telegram } = setup("2026-01-12T08:00:00Z");
    expect(await runPaymentsWatch({ ...deps, notifier: undefined })).toEqual([]);
    expect(texts).toHaveLength(2);
    expect(telegram.photos).toEqual([]);
  });
});

describe("payment keys", () => {
  it("knows the Payment keys and hides them from the text delivery", async () => {
    expect(isPaymentKey("payment:abc:1000001")).toBe(true);
    expect(isPaymentKey("payment:abc:1000001:reminder")).toBe(true);
    expect(isPaymentKey("fetch-cap:2026-01-12:1000001")).toBe(false);
    const storage = createMemoryStorage({ configs: [config] });
    await storage.enqueueNotification({ key: "payment:abc:1000001", familyId: FAMILY_ID, chatId: "1000001", text: "x" });
    await storage.enqueueNotification({ key: "failure:f:2026-01-12:1000001", familyId: FAMILY_ID, chatId: "1000001", text: "y" });
    expect((await withoutPaymentEntries(storage).pendingNotifications(FAMILY_ID)).map((e) => e.key)).toEqual(["failure:f:2026-01-12:1000001"]);
  });

  it("skips an entry of an unknown Payment and marks it delivered", async () => {
    const storage = createMemoryStorage({ configs: [config] });
    await storage.enqueueNotification({ key: "payment:missing:1000001", familyId: FAMILY_ID, chatId: "1000001", text: "x" });
    const { notifier, photos } = fakeTelegram();
    expect(await deliverPaymentPhotos({ storage, familyId: FAMILY_ID, notifier })).toEqual({ sent: [] });
    expect(photos).toEqual([]);
    expect(await storage.pendingNotifications(FAMILY_ID)).toEqual([]);
  });
});
