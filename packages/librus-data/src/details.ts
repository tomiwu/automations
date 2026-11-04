import type { DetailFilter, ItemDetail, NewItemDetail } from "./storage.ts";

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

/** True if the date is not before the optional lower bound. */
const notBefore = (date: string | null, from?: string): boolean =>
  from === undefined || (date !== null && date >= from);

/** True if the date is not after the optional upper bound. */
const notAfter = (date: string | null, to?: string): boolean =>
  to === undefined || (date !== null && date <= to);

/** True if the detail date is inside the optional from and to bounds. */
const dateMatches = (detail: ItemDetail, filter: DetailFilter): boolean =>
  notBefore(detail.date, filter.from) && notAfter(detail.date, filter.to);

/** True if the detail passes the filter. */
export function matchesFilter(detail: ItemDetail, filter: DetailFilter): boolean {
  if (filter.childId !== undefined && detail.childId !== filter.childId) return false;
  if (!dateMatches(detail, filter)) return false;
  return filter.since === undefined || detail.firstSeen.getTime() >= filter.since.getTime();
}
