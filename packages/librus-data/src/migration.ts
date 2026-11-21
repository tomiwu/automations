import type { StorageAdapter } from "./storage.ts";

export interface KodyStorage {
  get(key: string): Promise<unknown>;
}

export interface ExportedItem {
  id: string;
  firstSeen: string;
}

export interface ExportedEntry {
  key: string;
  chatId: string;
  text: string;
  queuedAt: string;
  deliveredAt: string | null;
}

export interface MigrationExport {
  version: 1;
  items: Record<string, ExportedItem[]>;
  outbox: ExportedEntry[];
}

export interface CountDifference {
  scope: string;
  expected: number;
  actual: number;
}

export interface ImportReport {
  items: Record<string, number>;
  pending: number;
}

export class CountCheckError extends Error {
  readonly differences: CountDifference[];

  constructor(differences: CountDifference[]) {
    const lines = differences.map((d) => `${d.scope}: expected ${d.expected}, found ${d.actual}`);
    super(`Count check failed. ${lines.join("; ")}`);
    this.name = "CountCheckError";
    this.differences = differences;
  }
}

async function load(storage: KodyStorage, key: string): Promise<unknown[]> {
  const raw = await storage.get(key);
  if (raw === undefined || raw === null) return [];
  const data = typeof raw === "string" ? parseJson(raw, key) : raw;
  if (!Array.isArray(data)) throw new Error(`Corrupt data for ${key}`);
  return data;
}

function parseJson(raw: string, key: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Corrupt data for ${key}`);
  }
}

const isText = (value: unknown): value is string => typeof value === "string" && value !== "";

function toItem(value: unknown, key: string): ExportedItem {
  const item = value as Partial<ExportedItem> | null;
  if (!isText(item?.id) || !isText(item?.firstSeen)) throw new Error(`Corrupt data for ${key}`);
  return { id: item.id, firstSeen: item.firstSeen };
}

const textOrNull = (value: unknown): string | null => (isText(value) ? value : null);

function field(entry: Partial<ExportedEntry> | null, name: "key" | "chatId" | "text" | "queuedAt"): string {
  const value = entry?.[name];
  if (!isText(value)) throw new Error("Corrupt data for outbox");
  return value;
}

function toEntry(value: unknown): ExportedEntry {
  const entry = value as Partial<ExportedEntry> | null;
  return {
    key: field(entry, "key"),
    chatId: field(entry, "chatId"),
    text: field(entry, "text"),
    queuedAt: field(entry, "queuedAt"),
    deliveredAt: textOrNull(entry?.deliveredAt),
  };
}

export async function exportKodyData(storage: KodyStorage, watchers: readonly string[]): Promise<MigrationExport> {
  const items: Record<string, ExportedItem[]> = {};
  for (const watcher of watchers) {
    const key = `items:${watcher}`;
    items[watcher] = (await load(storage, key)).map((value) => toItem(value, key));
  }
  const outbox = (await load(storage, "outbox"))
    .filter((value) => isText((value as { chatId?: unknown } | null)?.chatId))
    .map(toEntry);
  return { version: 1, items, outbox };
}

const uniqueCount = (ids: readonly string[]): number => new Set(ids).size;

function expectedCounts(data: MigrationExport): { items: Record<string, number>; pending: number } {
  const items: Record<string, number> = {};
  for (const [watcher, list] of Object.entries(data.items)) items[watcher] = uniqueCount(list.map((i) => i.id));
  const pending = uniqueCount(data.outbox.filter((e) => e.deliveredAt === null).map((e) => e.key));
  return { items, pending };
}

async function writeAll(storage: StorageAdapter, familyId: string, data: MigrationExport): Promise<void> {
  for (const [watcher, list] of Object.entries(data.items)) {
    await storage.recordItems(familyId, watcher, list.map((i) => i.id));
  }
  for (const entry of data.outbox) {
    await storage.enqueueNotification({ key: entry.key, familyId, chatId: entry.chatId, text: entry.text });
    if (entry.deliveredAt !== null) await storage.markDelivered(entry.key);
  }
}

async function compare(storage: StorageAdapter, familyId: string, data: MigrationExport): Promise<CountDifference[]> {
  const expected = expectedCounts(data);
  const differences: CountDifference[] = [];
  for (const [watcher, count] of Object.entries(expected.items)) {
    const actual = (await storage.knownItemIds(familyId, watcher)).size;
    if (actual !== count) differences.push({ scope: `items ${watcher}`, expected: count, actual });
  }
  const pending = (await storage.pendingNotifications(familyId)).length;
  if (pending !== expected.pending) differences.push({ scope: "pending outbox", expected: expected.pending, actual: pending });
  return differences;
}

export async function importKodyData(
  storage: StorageAdapter,
  familyId: string,
  data: MigrationExport,
): Promise<ImportReport> {
  await writeAll(storage, familyId, data);
  const differences = await compare(storage, familyId, data);
  if (differences.length > 0) throw new CountCheckError(differences);
  return expectedCounts(data);
}

export function parseMigrationExport(text: string): MigrationExport {
  const data = parseJson(text, "export file") as Partial<MigrationExport> | null;
  if (data?.version !== 1 || !isRecord(data.items) || !Array.isArray(data.outbox)) throw wrongFormat();
  return { version: 1, items: parseItems(data.items), outbox: data.outbox.map(toEntry) };
}

const wrongFormat = (): Error => new Error("The export file has a wrong format");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

function parseItems(items: Record<string, unknown>): Record<string, ExportedItem[]> {
  const result: Record<string, ExportedItem[]> = {};
  for (const [watcher, list] of Object.entries(items)) {
    if (!Array.isArray(list)) throw wrongFormat();
    result[watcher] = list.map((value) => toItem(value, `items:${watcher}`));
  }
  return result;
}
