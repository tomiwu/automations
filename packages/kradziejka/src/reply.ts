import { senderAllowed } from "./allowlist.ts";
import { rejectUnknown, textField } from "./input.ts";
import { splitText } from "./clip.ts";
import type { TelegramPort } from "./handle.ts";
import { rememberReply } from "./handle.ts";
import type { KeyValue } from "./state.ts";

const REPLY_KEYS = ["chat_id", "text"];
const MAX_TEXT = 12000;

export interface ReplyDeps {
  allowlist: readonly string[];
  kv: KeyValue;
  telegram: TelegramPort;
  now(): Date;
}

export interface ReplyResult {
  ok: true;
  chat_id: string;
}

/** Sends a Grok bot reply to an allowlisted chat and stores it in the chat memory. */
export async function handleReply(deps: ReplyDeps, raw: unknown): Promise<ReplyResult> {
  const input = parseReply(raw);
  if (!senderAllowed(deps.allowlist, { userId: input.chatId, chatType: "private" })) {
    throw new Error("This chat is not allowlisted.");
  }
  await sendParts(deps.telegram, input.chatId, input.text);
  await rememberReply(deps.kv, input.chatId, input.text, deps.now().toISOString());
  return { ok: true, chat_id: input.chatId };
}

export function parseReply(raw: unknown): { chatId: string; text: string } {
  const record = rejectUnknown(raw, REPLY_KEYS);
  const chatId = textField(record, "chat_id");
  const body = textField(record, "text");
  if (!chatId || !/^[0-9]{1,20}$/.test(chatId)) throw new Error("chat_id must be a decimal id.");
  if (!body || body.length > MAX_TEXT) throw new Error("text must be 1 to 12000 characters.");
  return { chatId, text: body };
}

async function sendParts(telegram: TelegramPort, chatId: string, body: string): Promise<void> {
  for (const part of splitText(body)) await telegram.send(chatId, part);
}
