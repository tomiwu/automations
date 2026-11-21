import { handleTelegramUpdate } from "../telegram-update.ts";
import { updateDeps } from "./common.ts";

/**
 * Accepts one Telegram update and handles the Paid and Skip buttons of the payment messages.
 * Kody calls this from the `telegram-update` webhook.
 *
 * @param input - The webhook envelope `{ webhook, request }` or a Telegram update object.
 * @returns `{ ok: true }`. An update that is not a payment callback is ignored.
 *
 * @example
 * import onUpdate from "kody:@tomiwu/payments-watch/telegram-update";
 * await onUpdate({ update_id: 1, callback_query: { id: "1", data: "pay:example:paid" } });
 */
export default async function telegramUpdate(input: unknown): Promise<{ ok: true }> {
  await handleTelegramUpdate(await updateDeps(), input);
  return { ok: true };
}
