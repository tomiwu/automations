import type { RouteChoice } from "./routing.ts";

export interface PhotoInfo {
  fileId: string;
  fileUniqueId: string;
  width: number;
  height: number;
  fileSize: number | null;
}

export interface ForwardTurn {
  from: "person" | "bot";
  text: string;
  at: string;
}

export interface ForwardInput {
  chatId: string;
  senderId: string;
  languageCode: string | null;
  text: string;
  photo: PhotoInfo | null;
  recent: readonly ForwardTurn[];
  lastBot: string | null;
  route: RouteChoice;
}

export const REPLY_INSTRUCTIONS =
  'Send the reply with an HTTPS POST to the kradziejka reply webhook. The owner has that URL. The JSON body is {"chat_id":"<chat_id from this payload>","text":"<reply>"}. Use the chat_id from this payload. Do not call the Telegram Bot API. Do not put a bot token or a Telegram file URL in the reply.';

/** Builds the JSON body for a Grok routine webhook. It has no Telegram file URL. */
export function buildForwardPayload(input: ForwardInput): Record<string, unknown> {
  const photo = input.photo ? publicPhoto(input.photo) : null;
  assertPhotoSafe(input.photo);
  return {
    chat_id: input.chatId,
    from: { id: input.senderId, language_code: input.languageCode },
    text: input.text,
    photo,
    recent: input.recent.map((turn) => ({ from: turn.from, text: turn.text, at: turn.at })),
    last_bot: input.lastBot,
    route: { slug: input.route.slug, intent: input.route.intent },
    reply_instructions: REPLY_INSTRUCTIONS,
  };
}

function publicPhoto(photo: PhotoInfo): Record<string, unknown> {
  return {
    file_id: photo.fileId,
    file_unique_id: photo.fileUniqueId,
    width: photo.width,
    height: photo.height,
    file_size: photo.fileSize,
  };
}

/** Rejects a file id that is a Telegram file URL. Those URLs contain the bot token. */
export function assertPhotoSafe(photo: PhotoInfo | null): void {
  if (!photo) return;
  const blob = `${photo.fileId} ${photo.fileUniqueId}`;
  if (blob.includes("api.telegram.org") || blob.includes("/file/bot")) {
    throw new Error("Refusing a Telegram file URL.");
  }
}
