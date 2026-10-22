import { handleReply, type ReplyResult } from "../reply.ts";
import { replyDeps } from "./common.ts";

/**
 * Sends a Grok bot reply to the Telegram chat.
 * The reply webhook calls this. The body is `{ chat_id, text }` and nothing else.
 *
 * @param input - `{ chat_id, text }`. Unknown keys are rejected.
 * @returns `{ ok: true, chat_id }`.
 *
 * @example
 * import reply from "kody:@tomiwu/kradziejka/reply";
 * await reply({ chat_id: "1000001", text: "The homework is on page 4." });
 */
export default async function reply(input: unknown): Promise<ReplyResult> {
  return handleReply(await replyDeps(), input);
}
