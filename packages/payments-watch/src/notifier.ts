import type { Fee, Payment } from "@automations/librus-data";
import { t, type Child, type FetchFn, type Recipient } from "@automations/shared";
import { formatAmount } from "./engine.ts";
import type { ZbpQr } from "./zbp.ts";

/** What the Notifier needs to describe one Payment. */
export interface PaymentNotice {
  child: Child;
  fee: Fee;
  payment: Payment;
  /** True for the reminder. The caption then starts with the reminder marker. */
  reminder?: boolean;
}

/** Delivers a Payment and its QR code to a Recipient. Watcher code knows only this port. Gives the Telegram message ID when known. */
export interface Notifier {
  sendPayment(recipient: Recipient, notice: PaymentNotice, qr: ZbpQr): Promise<number | void>;
}

export type TelegramParams = Record<string, string | number | boolean | Uint8Array | object>;

/** Calls one method of the Telegram bot API. It gives the result of the call, when there is one. */
export interface TelegramClient {
  call(method: string, params: TelegramParams): Promise<unknown>;
}

/** Reads `message_id` from a Telegram result, or from the `{ ok, result }` envelope of the bot API. */
export function messageIdOf(response: unknown): number | undefined {
  const record = (response ?? {}) as Record<string, unknown>;
  const id = record.message_id ?? record.messageId;
  return typeof id === "number" ? id : record.result === undefined ? undefined : messageIdOf(record.result);
}

const pad = (value: number): string => String(value).padStart(2, "0");

function differingConfigAmount({ fee, payment }: PaymentNotice): number | undefined {
  const configured = fee.amounts[payment.month];
  if (payment.amountSource !== "page" || !configured || configured === payment.amount) return undefined;
  return configured;
}

function captionOf(recipient: Recipient, notice: PaymentNotice): string {
  const { child, fee, payment } = notice;
  const language = recipient.language;
  const lines = [
    ...(notice.reminder ? [t(language, "payment.reminder_marker")] : []),
    t(language, "payment.caption", {
      child: child.name,
      organizer: fee.organizer,
      month: payment.month,
      amount: formatAmount(payment.amount),
      date: `${payment.month}-${pad(fee.dueDay)}`,
      source: t(language, `payment.source.${payment.amountSource}`),
    }),
  ];
  const configured = differingConfigAmount(notice);
  if (configured !== undefined) {
    lines.push(
      t(language, "payment.amounts_differ", { page: formatAmount(payment.amount), config: formatAmount(configured) }),
    );
  }
  return lines.join("\n");
}

function buttonsOf(recipient: Recipient, payment: Payment) {
  return {
    inline_keyboard: [
      [
        { text: t(recipient.language, "payment.button.paid"), callback_data: `pay:${payment.id}:paid` },
        { text: t(recipient.language, "payment.button.skip"), callback_data: `pay:${payment.id}:skip` },
      ],
    ],
  };
}

/** The v1 adapter. It sends the QR code as a photo with a caption and the buttons `Paid` and `Skip`. */
export function createTelegramNotifier(client: TelegramClient): Notifier {
  return {
    async sendPayment(recipient, notice, qr) {
      return messageIdOf(await client.call("sendPhoto", {
        chat_id: recipient.telegram_chat_id,
        photo: qr.png,
        caption: captionOf(recipient, notice),
        reply_markup: buttonsOf(recipient, notice.payment),
      }));
    },
  };
}

function formOf(params: TelegramParams): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(params)) {
    if (value instanceof Uint8Array) form.append(name, new Blob([value as BlobPart], { type: "image/png" }), `${name}.png`);
    else form.append(name, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return form;
}

/** Calls the bot API with `fetch`. The error message never contains the token. */
export function createTelegramHttpClient(fetchFn: FetchFn, token: string): TelegramClient {
  return {
    async call(method, params) {
      const response = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
        method: "POST",
        body: formOf(params),
      });
      if (!response.ok) throw new Error(`Telegram ${method} failed with status ${response.status}`);
      return response.json().catch(() => undefined);
    },
  };
}
