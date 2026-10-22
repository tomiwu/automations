import { handleTelegramUpdate, type HandleResult } from "../handle.ts";
import { handlerDeps } from "./common.ts";

/**
 * Accepts one Telegram update and routes it to a Grok bot.
 * Kody calls this from the `telegram-update` webhook. Do not call it as a live test.
 *
 * @param input - The webhook envelope `{ webhook, request }` or a Telegram update object.
 * @returns `{ ok: true, status }`. `dropped` means the sender is not allowlisted. No Telegram message is sent in that case.
 *
 * @example
 * import onUpdate from "kody:@tomiwu/kradziejka/telegram-update";
 * await onUpdate({
 *   update_id: 1,
 *   message: { message_id: 1, from: { id: 1000001 }, chat: { id: 1000001, type: "private" }, text: "Hello" },
 * });
 */
export default async function telegramUpdate(input: unknown): Promise<HandleResult> {
  return handleTelegramUpdate(await handlerDeps(), input);
}
