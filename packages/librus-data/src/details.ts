import type { DetailFilter, ItemDetail, ItemKind, JournalEvent, JournalFilter, NewItemDetail, NewJournalEvent, StorageAdapter } from "./storage.ts";

/** Rows per request when the adapter stores details. */
export const DETAIL_BATCH_SIZE = 100;

/** A SHA-256 hex digest of the content of a detail. Changed content gives another hash. */
export async function detailHash(row: NewItemDetail): Promise<string> {
  const content = JSON.stringify([
    row.kind,
    row.childId,
    row.date,
    row.startTime,
    row.endTime,
    row.title,
    row.text,
    row.sender,
    row.subject,
    row.category,
    row.sourceUpdatedAt?.toISOString() ?? null,
  ]);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The identity of a stored detail: Family, scope, source ID and content hash. */
export const detailSlot = (row: NewItemDetail, hash: string): string =>
  JSON.stringify([row.familyId, row.scope, row.sourceId, hash]);

/** The rows without repeats, in the first-seen order. A repeat has the same Family, scope, source ID and hash. */
export async function uniqueDetails(
  rows: readonly NewItemDetail[],
): Promise<{ row: NewItemDetail; hash: string }[]> {
  const unique = new Map<string, { row: NewItemDetail; hash: string }>();
  for (const row of rows) {
    const hash = await detailHash(row);
    const slot = detailSlot(row, hash);
    if (!unique.has(slot)) unique.set(slot, { row, hash });
  }
  return [...unique.values()];
}

/** The kinds of Item events in the Journal. */
export const ITEM_KINDS: readonly ItemKind[] = ["meeting", "dayOff", "trip", "terminarz", "announcement", "message", "grade"];

const itemStream = (row: Pick<NewItemDetail, "scope" | "sourceId">): string => `item:${row.scope}:${row.sourceId}`;

const timeOrNull = (date: Date | null): string | null => date?.toISOString() ?? null;

function itemPayload(row: NewItemDetail): Record<string, unknown> {
  return {
    scope: row.scope,
    sourceId: row.sourceId,
    kind: row.kind,
    childId: row.childId,
    date: row.date,
    startTime: row.startTime,
    endTime: row.endTime,
    title: row.title,
    text: row.text,
    sender: row.sender,
    subject: row.subject,
    category: row.category,
    sourceUpdatedAt: timeOrNull(row.sourceUpdatedAt),
  };
}

const headSlot = (head: { familyId: string; stream: string }): string => JSON.stringify([head.familyId, head.stream]);

/** The Item events for rows whose content differs from the head of their stream. Repeats in the rows are skipped. */
export async function itemEvents(
  rows: readonly NewItemDetail[],
  heads: readonly JournalEvent[],
): Promise<NewJournalEvent[]> {
  const last = new Map(heads.map((head) => [headSlot(head), { seq: head.seq, hash: head.contentHash }]));
  const events: NewJournalEvent[] = [];
  for (const { row, hash } of await uniqueDetails(rows)) {
    const stream = itemStream(row);
    const slot = headSlot({ familyId: row.familyId, stream });
    const head = last.get(slot);
    if (head?.hash === hash) continue;
    const seq = (head?.seq ?? 0) + 1;
    last.set(slot, { seq, hash });
    events.push({
      familyId: row.familyId,
      childId: row.childId,
      stream,
      seq,
      kind: row.kind,
      day: row.date,
      eventType: head ? "ItemChanged" : "ItemRecorded",
      payload: itemPayload(row),
      contentHash: hash,
      source: "librus-watch",
    });
  }
  return events;
}

/** The heads of the Item streams of the rows, read with one request for each 100 streams. */
async function itemHeads(storage: StorageAdapter, rows: readonly NewItemDetail[]): Promise<JournalEvent[]> {
  const heads: JournalEvent[] = [];
  for (const familyId of new Set(rows.map((row) => row.familyId))) {
    const streams = [...new Set(rows.filter((row) => row.familyId === familyId).map(itemStream))];
    heads.push(...(await storage.listHeads(familyId, { streams })));
  }
  return heads;
}

/** Appends the Item events for the rows. One `appendEvents` call, or none if no row is new. */
export async function appendItemEvents(storage: StorageAdapter, rows: readonly NewItemDetail[]): Promise<void> {
  if (rows.length === 0) return;
  const events = await itemEvents(rows, await itemHeads(storage, rows));
  if (events.length > 0) await storage.appendEvents(events);
}

/** The Item detail that an Item event shows. */
export function detailOfEvent(event: JournalEvent): ItemDetail {
  const payload = event.payload as Record<string, string | null>;
  return {
    familyId: event.familyId,
    scope: payload.scope as string,
    kind: payload.kind as ItemKind,
    childId: payload.childId as string,
    sourceId: payload.sourceId as string,
    date: payload.date as string | null,
    startTime: payload.startTime as string | null,
    endTime: payload.endTime as string | null,
    title: payload.title as string,
    text: payload.text as string,
    sender: payload.sender as string | null,
    subject: payload.subject as string | null,
    category: payload.category as string | null,
    sourceUpdatedAt: payload.sourceUpdatedAt === null ? null : new Date(payload.sourceUpdatedAt as string),
    firstSeen: event.recordedAt,
  };
}

/** The details that Item events show, oldest first. Events with the same time keep their order. */
export const detailsOfEvents = (events: readonly JournalEvent[]): ItemDetail[] =>
  events.map(detailOfEvent).sort((a, b) => a.firstSeen.getTime() - b.firstSeen.getTime());

/** Reads the details of a Family from the Item events of the Journal, oldest first. */
export async function detailsFromJournal(
  storage: StorageAdapter,
  familyId: string,
  filter: DetailFilter,
): Promise<ItemDetail[]> {
  const where: JournalFilter = { ...filter, kinds: ITEM_KINDS };
  return detailsOfEvents(await storage.listEvents(familyId, where));
}
