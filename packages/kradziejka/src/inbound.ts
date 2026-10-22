import { asRecord, numberField, textField } from "./input.ts";
import { pickPhoto } from "./photo.ts";
import type { PhotoInfo } from "./payload.ts";
import type { VoiceNote } from "./speech.ts";

export interface Inbound {
  updateId: number;
  chatId: string;
  chatType: string;
  userId: string;
  languageCode: string | null;
  text: string;
  photo: PhotoInfo | null;
  voice: VoiceNote | null;
}

/** Reads a Telegram update, or the webhook envelope that wraps one. */
export function parseInbound(raw: unknown): Inbound | null {
  const update = asRecord(updateBody(raw));
  if (!update) return null;
  const message = asRecord(update.message);
  const updateId = numberField(update, "update_id");
  if (!message || !safeId(updateId)) return null;
  return fromMessage(updateId as number, message);
}

function safeId(updateId: number | null): boolean {
  return updateId !== null && Number.isSafeInteger(updateId) && updateId >= 0;
}

function updateBody(raw: unknown): unknown {
  const record = asRecord(raw);
  if (!record || !("request" in record)) return raw;
  const request = asRecord(record.request);
  return request ? request.json : null;
}

function fromMessage(updateId: number, message: Record<string, unknown>): Inbound | null {
  const people = peopleOf(message);
  if (!people) return null;
  const identity = identityOf(people.chat, people.from);
  if (!identity) return null;
  return {
    updateId,
    ...identity,
    languageCode: textField(people.from, "language_code"),
    text: messageText(message),
    photo: pickPhoto(message.photo),
    voice: readVoice(message.voice),
  };
}

function peopleOf(message: Record<string, unknown>): { chat: Record<string, unknown>; from: Record<string, unknown> } | null {
  const chat = asRecord(message.chat);
  const from = asRecord(message.from);
  if (!chat || !from) return null;
  return { chat, from };
}

function identityOf(chat: Record<string, unknown>, from: Record<string, unknown>): { chatId: string; chatType: string; userId: string } | null {
  const chatId = idText(chat.id);
  const userId = idText(from.id);
  if (!chatId || !userId) return null;
  return { chatId, chatType: chatTypeOf(chat.type), userId };
}

function chatTypeOf(value: unknown): string {
  if (typeof value !== "string") return "";
  return value;
}

function idText(value: unknown): string | null {
  if (typeof value === "number") return numberId(value);
  if (typeof value === "string") return stringId(value);
  return null;
}

function numberId(value: number): string | null {
  if (!Number.isSafeInteger(value) || value <= 0) return null;
  return String(value);
}

function stringId(value: string): string | null {
  if (!/^[0-9]{1,20}$/.test(value)) return null;
  return value;
}

function messageText(message: Record<string, unknown>): string {
  return textField(message, "text") ?? textField(message, "caption") ?? "";
}

function readVoice(value: unknown): VoiceNote | null {
  const row = asRecord(value);
  if (!row) return null;
  return voiceFrom(row);
}

function voiceFrom(row: Record<string, unknown>): VoiceNote | null {
  const fileId = textField(row, "file_id");
  const duration = numberField(row, "duration");
  if (!fileId || duration === null) return null;
  if (fileId.includes("api.telegram.org")) return null;
  return { fileId, durationSeconds: duration, mimeType: textField(row, "mime_type") };
}
