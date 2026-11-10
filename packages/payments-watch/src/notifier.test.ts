import type { Fee, Payment } from "@automations/librus-data";
import type { Child, Recipient } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { createTelegramNotifier, type TelegramClient, type TelegramParams } from "./notifier.ts";

const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
const CHILD: Child = { id: "c1", family_id: FAMILY_ID, name: "Child One", has_librus: true, calendar_id: null };
const PAYMENT_ID = "00000000-0000-4000-8000-0000000000a1";

const fee: Fee = {
  id: "f1",
  familyId: FAMILY_ID,
  childId: "c1",
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

const payment: Payment = {
  id: PAYMENT_ID,
  familyId: FAMILY_ID,
  feeId: "f1",
  month: "2025-02",
  amount: 15050,
  amountSource: "config",
  status: "pending",
  notifiedAt: null,
  remindedAt: null,
  decidedAt: null,
  decidedBy: null,
  createdAt: new Date("2025-02-10T08:00:00Z"),
};

const png = Buffer.from([137, 80, 78, 71]);
const qr = { text: "|PL|61109010140000071219812874|015050|x|y|||", png };

const recipient = (language: "en" | "pl"): Recipient => ({
  id: "r1",
  family_id: FAMILY_ID,
  telegram_chat_id: "1000001",
  language,
  child_ids: ["c1"],
});

function setup() {
  const calls: { method: string; params: TelegramParams }[] = [];
  const client: TelegramClient = {
    async call(method, params) {
      calls.push({ method, params });
    },
  };
  return { calls, notifier: createTelegramNotifier(client) };
}

describe("createTelegramNotifier", () => {
  it("sends a photo with the QR code to the chat of the Recipient", async () => {
    const { calls, notifier } = setup();
    await notifier.sendPayment(recipient("en"), { child: CHILD, fee, payment }, qr);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("sendPhoto");
    expect(calls[0]?.params.chat_id).toBe("1000001");
    expect(calls[0]?.params.photo).toBe(png);
  });

  it("writes the caption in the language of the Recipient", async () => {
    const { calls, notifier } = setup();
    await notifier.sendPayment(recipient("en"), { child: CHILD, fee, payment }, qr);
    await notifier.sendPayment(recipient("pl"), { child: CHILD, fee, payment }, qr);
    expect(calls[0]?.params.caption).toBe(
      "Child One: Example Organizer, 2025-02\n150.50 PLN, due 2025-02-20\nAmount source: config",
    );
    expect(calls[1]?.params.caption).toBe(
      "Child One: Example Organizer, 2025-02\n150.50 PLN, termin 2025-02-20\nŹródło kwoty: konfiguracja",
    );
  });

  it("starts the caption of a reminder with the reminder marker", async () => {
    const { calls, notifier } = setup();
    await notifier.sendPayment(recipient("en"), { child: CHILD, fee, payment, reminder: true }, qr);
    await notifier.sendPayment(recipient("pl"), { child: CHILD, fee, payment, reminder: true }, qr);
    expect(String(calls[0]?.params.caption).split("\n")[0]).toBe("Reminder: not paid yet.");
    expect(String(calls[1]?.params.caption).split("\n")[0]).toBe("Przypomnienie: brak wpłaty.");
    expect(calls[0]?.params.reply_markup).toBeDefined();
  });

  it("adds two inline buttons with the callback data", async () => {
    const { calls, notifier } = setup();
    await notifier.sendPayment(recipient("en"), { child: CHILD, fee, payment }, qr);
    expect(calls[0]?.params.reply_markup).toEqual({
      inline_keyboard: [
        [
          { text: "Paid", callback_data: `pay:${PAYMENT_ID}:paid` },
          { text: "Skip", callback_data: `pay:${PAYMENT_ID}:skip` },
        ],
      ],
    });
  });

  it("names the buttons in the language of the Recipient", async () => {
    const { calls, notifier } = setup();
    await notifier.sendPayment(recipient("pl"), { child: CHILD, fee, payment }, qr);
    expect(JSON.stringify(calls[0]?.params.reply_markup)).toContain("Zapłacone");
  });

  it("shows both amounts when the page and the config differ", async () => {
    const { calls, notifier } = setup();
    const fromPage: Payment = { ...payment, amount: 16000, amountSource: "page" };
    await notifier.sendPayment(recipient("en"), { child: CHILD, fee, payment: fromPage }, qr);
    const caption = String(calls[0]?.params.caption);
    expect(caption).toContain("160.00 PLN, due");
    expect(caption).toContain("Amount source: organizer page");
    expect(caption).toContain("The page shows 160.00 PLN. The config shows 150.50 PLN.");
  });

  it("shows one amount when the page and the config are equal", async () => {
    const { calls, notifier } = setup();
    const fromPage: Payment = { ...payment, amountSource: "page" };
    await notifier.sendPayment(recipient("en"), { child: CHILD, fee, payment: fromPage }, qr);
    expect(String(calls[0]?.params.caption)).not.toContain("The config shows");
  });

  it("shows one amount when the config has no amount for the month", async () => {
    const { calls, notifier } = setup();
    const fromPage: Payment = { ...payment, month: "2025-03", amountSource: "page" };
    await notifier.sendPayment(recipient("en"), { child: CHILD, fee, payment: fromPage }, qr);
    expect(String(calls[0]?.params.caption)).not.toContain("The config shows");
  });
});

describe("createTelegramHttpClient", () => {
  it("posts the method to the bot API as multipart form data", async () => {
    const { createTelegramHttpClient } = await import("./notifier.ts");
    const requests: { url: string; body: FormData }[] = [];
    const client = createTelegramHttpClient(async (url, init) => {
      requests.push({ url, body: init?.body as FormData });
      return new Response('{"ok":true}');
    }, "TOKEN_PLACEHOLDER");
    await client.call("sendPhoto", {
      chat_id: "1000001",
      photo: png,
      caption: "Caption",
      reply_markup: { inline_keyboard: [] },
    });
    expect(requests[0]?.url).toBe("https://api.telegram.org/botTOKEN_PLACEHOLDER/sendPhoto");
    expect(requests[0]?.body.get("chat_id")).toBe("1000001");
    expect(requests[0]?.body.get("caption")).toBe("Caption");
    expect(requests[0]?.body.get("reply_markup")).toBe('{"inline_keyboard":[]}');
    expect(requests[0]?.body.get("photo")).toBeInstanceOf(Blob);
  });

  it("throws without the token in the message when Telegram refuses", async () => {
    const { createTelegramHttpClient } = await import("./notifier.ts");
    const client = createTelegramHttpClient(async () => new Response("{}", { status: 400 }), "TOKEN_PLACEHOLDER");
    const error = await client.call("sendPhoto", { chat_id: "1" }).catch((caught: Error) => caught);
    expect((error as Error).message).toBe("Telegram sendPhoto failed with status 400");
  });
});

describe("messageIdOf", () => {
  it.each([
    [{ message_id: 5 }, 5],
    [{ ok: true, result: { message_id: 6 } }, 6],
    [{ ok: true, messageId: 7 }, 7],
    [undefined, undefined],
    ["text", undefined],
    [{ ok: true }, undefined],
  ])("reads the message ID from %j", async (response, expected) => {
    const { messageIdOf } = await import("./notifier.ts");
    expect(messageIdOf(response)).toBe(expected);
  });
});
