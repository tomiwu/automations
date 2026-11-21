import type { FetchFn } from "@automations/shared";

/** Telegram bots may upload files up to 50 MB. The watcher stores only files below this limit. */
export const DOCUMENT_SIZE_LIMIT = 45 * 1024 * 1024;

/**
 * The bot token as a Kody secret placeholder in the URL path, as the `@tomiwu/telegram` package sends it. Kody fills it
 * at the network boundary for the approved host. The code never sees the value. The `./request` export of that package
 * takes JSON params only, so a file upload cannot go through it (#190).
 */
export const SEND_DOCUMENT_URL = "https://api.telegram.org/bot{{secret:TELEGRAM_BOT_TOKEN}}/sendDocument";

export interface DocumentUpload {
  chatId: string;
  fileName: string;
  caption: string;
  bytes: Uint8Array;
  contentType?: string;
}

const encoder = new TextEncoder();

/** A header value without quotes, CR or LF, so a file name cannot break the multipart frame. */
function headerSafe(value: string): string {
  return value.replace(/["\r\n\\]/g, "_");
}

function textPart(boundary: string, name: string, value: string): string {
  return `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
}

/** The `multipart/form-data` body of one `sendDocument` call. The file bytes are copied unchanged. */
export function sendDocumentBody(upload: DocumentUpload, boundary: string): Uint8Array<ArrayBuffer> {
  const head = encoder.encode(
    textPart(boundary, "chat_id", upload.chatId) +
      textPart(boundary, "caption", upload.caption) +
      `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${headerSafe(upload.fileName)}"\r\n` +
      `Content-Type: ${upload.contentType ?? "application/octet-stream"}\r\n\r\n`,
  );
  const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
  const body = new Uint8Array(new ArrayBuffer(head.byteLength + upload.bytes.byteLength + tail.byteLength));
  body.set(head, 0);
  body.set(upload.bytes, head.byteLength);
  body.set(tail, head.byteLength + upload.bytes.byteLength);
  return body;
}

function randomBoundary(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
  return `librus-watch-${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Uploads one document with `sendDocument`. It rejects on a file over the limit, an HTTP error or `ok: false`.
 * The error text has the status only, never the URL, the file name or the bytes.
 */
export async function sendTelegramDocument(fetchFn: FetchFn, upload: DocumentUpload, boundary = randomBoundary()): Promise<void> {
  if (upload.bytes.byteLength > DOCUMENT_SIZE_LIMIT) throw new Error("telegram sendDocument: file over the size limit");
  const response = await fetchFn(SEND_DOCUMENT_URL, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: sendDocumentBody(upload, boundary),
  });
  const answer = (await response.json().catch(() => undefined)) as { ok?: unknown } | undefined;
  if (!response.ok || answer?.ok !== true) throw new Error(`telegram sendDocument failed with status ${response.status}`);
}
