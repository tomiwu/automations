import type { OutboxEntry, StorageAdapter } from "@automations/librus-data";

/** Sends text or a document to one Telegram chat. It rejects when the delivery failed. */
export interface Messenger {
  send(chatId: string, text: string): Promise<void>;
  sendDocument?(chatId: string, fileName: string, bytes: Uint8Array, caption: string): Promise<void>;
}

/** Default time limit of one send, in milliseconds. */
export const SEND_TIMEOUT_MS = 20_000;
/**
 * Upper time limit of one document upload, in milliseconds. A file near 10 MB can take longer than a text send. A
 * document gets the rest of the delivery budget, at least `SEND_TIMEOUT_MS` and at most this, so a delivery run still
 * ends at most `SEND_TIMEOUT_MS` after its budget, as with text.
 */
export const DOCUMENT_SEND_TIMEOUT_MS = 45_000;
/** Default time limit of one delivery run, in milliseconds. */
export const DELIVERY_BUDGET_MS = 60_000;
/** Telegram accepts at most 4096 characters in one message. */
const TELEGRAM_CHUNK = 4000;

/** Rejects when the promise does not settle in time. The work itself is not cancelled. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sliceLine(line: string, limit: number): string[] {
  const pieces: string[] = [];
  for (let start = 0; start < line.length; start += limit) pieces.push(line.slice(start, start + limit));
  return pieces;
}

/** Splits a text into pieces of at most `limit` characters. It prefers line breaks. */
export function splitForTelegram(text: string, limit = TELEGRAM_CHUNK): string[] {
  const chunks: string[] = [];
  let current: string | undefined;
  for (const piece of text.split("\n").flatMap((line) => (line.length > limit ? sliceLine(line, limit) : [line]))) {
    if (current === undefined) current = piece;
    else if (current.length + 1 + piece.length <= limit) current += `\n${piece}`;
    else {
      chunks.push(current);
      current = piece;
    }
  }
  return [...chunks, current ?? ""];
}

/** Removes secret placeholders such as `{{secret:NAME}}` from a text that goes to Telegram. */
export function redactSecretPlaceholders(text: string): string {
  return text.replace(/\{\{\s*secret[^}]*\}\}/gi, "[secret]");
}

export interface DeliveryOptions {
  storage: StorageAdapter;
  familyId: string;
  messenger: Messenger;
  /** Telegram chat IDs of the Recipients. Entries for other chats stay in the Outbox. */
  chatIds: readonly string[];
  log?: (message: string) => void;
  /** Returns the time in ms. The tests replace it. */
  clock?: () => number;
  budgetMs?: number;
  sendTimeoutMs?: number;
  documentTimeoutMs?: number;
}

/** The time limit of one document upload: the rest of the budget, between the text limit and the document limit. */
export function documentTimeout(remainingMs: number, sendTimeoutMs: number, documentTimeoutMs: number): number {
  return Math.max(sendTimeoutMs, Math.min(documentTimeoutMs, remainingMs));
}

async function sendEntry(options: DeliveryOptions, entry: OutboxEntry, remainingMs: number): Promise<void> {
  const { storage, messenger, sendTimeoutMs = SEND_TIMEOUT_MS, documentTimeoutMs = DOCUMENT_SEND_TIMEOUT_MS } = options;
  if (entry.kind === "document") {
    const path = entry.storagePath;
    const fileName = entry.fileName;
    if (!path || !fileName) throw new Error("document outbox entry is incomplete");
    const bytes = await storage.getAttachment(path);
    const sendDocument = messenger.sendDocument;
    if (!sendDocument) throw new Error("telegram sendDocument is not available");
    await withTimeout(
      sendDocument(entry.chatId, fileName, bytes, redactSecretPlaceholders(entry.text)),
      documentTimeout(remainingMs, sendTimeoutMs, documentTimeoutMs),
      "telegram document",
    );
    return;
  }
  await withTimeout(messenger.send(entry.chatId, redactSecretPlaceholders(entry.text)), sendTimeoutMs, "telegram send");
}

interface DeliveryRun {
  /** Keys of the sent entries. They are marked delivered in one write at the end. */
  sentKeys: string[];
  failures: unknown[];
  /** Chats that had a failed send. Their later entries stay queued, so the order is kept. */
  blocked: Set<string>;
}

/**
 * Entries of one insert share one queued_at, and Postgres gives no order between equal values. A message text then
 * goes before its documents.
 */
function inSendOrder(entries: OutboxEntry[]): OutboxEntry[] {
  const rank = (entry: OutboxEntry) => (entry.kind === "document" ? 1 : 0);
  return [...entries].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime() || rank(a) - rank(b));
}

async function tryEntry(options: DeliveryOptions, entry: OutboxEntry, run: DeliveryRun, remainingMs: number): Promise<void> {
  try {
    await sendEntry(options, entry, remainingMs);
    run.sentKeys.push(entry.key);
  } catch (error) {
    run.blocked.add(entry.chatId);
    run.failures.push(error);
  }
}

/**
 * The Notifier of this package. It delivers the Outbox in order. An entry is marked delivered only after
 * its send succeeded. The sent entries are marked in one write at the end. A failed send holds back only
 * its own chat. When all chats are tried, it rejects with the first failure. The log gets counts only, never texts.
 */
export async function deliverPending(options: DeliveryOptions): Promise<void> {
  const { storage, familyId, chatIds, log = () => {}, clock = Date.now, budgetMs = DELIVERY_BUDGET_MS } = options;
  const start = clock();
  const queue = inSendOrder((await storage.pendingNotifications(familyId)).filter((entry) => chatIds.includes(entry.chatId)));
  const run: DeliveryRun = { sentKeys: [], failures: [], blocked: new Set() };
  try {
    for (const entry of queue) {
      const remainingMs = budgetMs - (clock() - start);
      if (!run.blocked.has(entry.chatId) && remainingMs > 0) await tryEntry(options, entry, run, remainingMs);
    }
  } finally {
    await storage.markDeliveredMany(run.sentKeys);
  }
  log(`deliver: queued=${queue.length} sent=${run.sentKeys.length} failed=${run.failures.length}`);
  if (run.failures.length > 0) throw run.failures[0];
}
