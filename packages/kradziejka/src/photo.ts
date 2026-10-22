import { asRecord, numberField, textField } from "./input.ts";
import type { PhotoInfo } from "./payload.ts";

/** Picks the largest photo and keeps only safe fields. Unknown fields are dropped. */
export function pickPhoto(value: unknown): PhotoInfo | null {
  if (!Array.isArray(value)) return null;
  let best: PhotoInfo | null = null;
  for (const item of value) best = larger(best, readPhoto(item));
  return best;
}

function larger(best: PhotoInfo | null, next: PhotoInfo | null): PhotoInfo | null {
  if (!next) return best;
  if (!best || area(next) >= area(best)) return next;
  return best;
}

function area(photo: PhotoInfo): number {
  return photo.width * photo.height;
}

function readPhoto(value: unknown): PhotoInfo | null {
  const row = asRecord(value);
  if (!row) return null;
  const photo = photoFrom(row);
  if (!photo) return null;
  if (unsafePhoto(photo)) return null;
  return photo;
}

function photoFrom(row: Record<string, unknown>): PhotoInfo | null {
  const fileId = textField(row, "file_id");
  const width = numberField(row, "width");
  const height = numberField(row, "height");
  if (!sized(fileId, width, height)) return null;
  return { fileId: fileId as string, fileUniqueId: uniqueId(row), width: width as number, height: height as number, fileSize: numberField(row, "file_size") };
}

function sized(fileId: string | null, width: number | null, height: number | null): boolean {
  return fileId !== null && width !== null && height !== null;
}

function uniqueId(row: Record<string, unknown>): string {
  const value = textField(row, "file_unique_id");
  if (value === null) return "";
  return value;
}

function unsafePhoto(photo: PhotoInfo): boolean {
  const blob = `${photo.fileId} ${photo.fileUniqueId}`;
  return blob.includes("api.telegram.org") || blob.includes("/file/bot");
}
