import type { OutboxEntry, StorageAdapter } from "@automations/librus-data";

/** Sends one message to one Telegram chat. It rejects when the delivery failed. */
export interface Messenger {
  send(chatId: string, text: string): Promise<void>;
}

/** Default time limit of one send, in milliseconds. */
export const SEND_TIMEOUT_MS = 20_000;
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
}

async function sendEntry(options: DeliveryOptions, entry: OutboxEntry): Promise<void> {
  const { storage, messenger, sendTimeoutMs = SEND_TIMEOUT_MS } = options;
  await withTimeout(messenger.send(entry.chatId, redactSecretPlaceholders(entry.text)), sendTimeoutMs, "telegram send");
  await storage.markDelivered(entry.key);
}

interface DeliveryRun {
  sent: number;
  failures: unknown[];
  /** Chats that had a failed send. Their later entries stay queued, so the order is kept. */
  blocked: Set<string>;
}

async function tryEntry(options: DeliveryOptions, entry: OutboxEntry, run: DeliveryRun): Promise<void> {
  try {
    await sendEntry(options, entry);
    run.sent += 1;
  } catch (error) {
    run.blocked.add(entry.chatId);
    run.failures.push(error);
  }
}

/**
 * The Notifier of this package. It delivers the Outbox in order. An entry is marked delivered only after
 * its send succeeded. A failed send holds back only its own chat. When all chats are tried, it rejects
 * with the first failure. The log gets counts only, never texts.
 */
export async function deliverPending(options: DeliveryOptions): Promise<void> {
  const { storage, familyId, chatIds, log = () => {}, clock = Date.now, budgetMs = DELIVERY_BUDGET_MS } = options;
  const start = clock();
  const queue = (await storage.pendingNotifications(familyId)).filter((entry) => chatIds.includes(entry.chatId));
  const run: DeliveryRun = { sent: 0, failures: [], blocked: new Set() };
  for (const entry of queue) {
    if (!run.blocked.has(entry.chatId) && clock() - start < budgetMs) await tryEntry(options, entry, run);
  }
  log(`deliver: queued=${queue.length} sent=${run.sent} failed=${run.failures.length}`);
  if (run.failures.length > 0) throw run.failures[0];
}
