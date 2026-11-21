import { routeTelegramUpdate, type TelegramUpdate } from "@tomiwu/librus-watch";
import { handlePaymentCallback, type CallbackDeps, type CallbackQuery } from "./callback.ts";

export interface UpdateDeps {
  callback: CallbackDeps;
  log(message: string): void;
}

type Fields = Record<string, unknown>;

function asRecord(value: unknown): Fields | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Fields;
}

function updateOf(raw: unknown): TelegramUpdate | undefined {
  const record = asRecord(raw);
  if (!record) return undefined;
  const body = "request" in record ? asRecord(asRecord(record.request)?.json) : record;
  return body as TelegramUpdate | undefined;
}

type Located = Pick<CallbackQuery, "chatId" | "messageId" | "caption">;

function locationOf(message: Fields | undefined): Located | undefined {
  const chatId = asRecord(message?.chat)?.id;
  if (typeof message?.message_id !== "number") return undefined;
  if (typeof chatId !== "number" && typeof chatId !== "string") return undefined;
  const caption = typeof message.caption === "string" ? message.caption : undefined;
  return { chatId: String(chatId), messageId: message.message_id, caption };
}

function queryOf(update: TelegramUpdate): CallbackQuery | undefined {
  const raw = asRecord(update.callback_query);
  const location = locationOf(asRecord(raw?.message));
  if (typeof raw?.id !== "string" || typeof raw.data !== "string" || !location) return undefined;
  return { id: raw.id, data: raw.data, ...location };
}

async function handlePayment(deps: UpdateDeps, update: TelegramUpdate): Promise<void> {
  const query = queryOf(update);
  if (!query) {
    deps.log("Payment callback ignored: the callback has no message.");
    return;
  }
  await handlePaymentCallback(deps.callback, query);
}

export async function handleTelegramUpdate(deps: UpdateDeps, raw: unknown): Promise<void> {
  const update = updateOf(raw);
  if (!update) {
    deps.log("Update ignored: the input is not a Telegram update.");
    return;
  }
  await routeTelegramUpdate(update, {
    payment: (routed) => handlePayment(deps, routed),
    other: async () => deps.log("Update ignored: it is not a payment callback."),
  });
}
