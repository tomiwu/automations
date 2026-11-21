import { localDate } from "@automations/shared";
import { detailHash, type ItemDetail, type ItemKind } from "@automations/librus-data";

export const DEFAULT_SINCE_DAYS = 7;

export interface EventsInput {
  childId?: string;
  from?: string;
  to?: string;
  since?: Date;
}

export interface CalendarEvent {
  id: string;
  kind: ItemKind;
  date: string | null;
  endDate: string | null;
  start: string | null;
  end: string | null;
  title: string;
  text: string;
  sender: string | null;
  subject: string | null;
  category: string | null;
  sourceUpdatedAt: string | null;
  firstSeen: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const RANGE = /^(\d{4}-\d{2}-\d{2}) - (\d{4}-\d{2}-\d{2})$/m;
const RANGE_KINDS: readonly ItemKind[] = ["trip", "dayOff"];
const DATELESS_KINDS: readonly ItemKind[] = ["announcement", "message"];

export function checkDay(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !DAY.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be a date YYYY-MM-DD.`);
  }
  return value;
}

export function checkSince(value: unknown, now: Date): Date {
  if (value === undefined) return new Date(now.getTime() - DEFAULT_SINCE_DAYS * 86_400_000);
  const since = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(since.getTime())) throw new Error("since must be an ISO time.");
  return since;
}

export const rangeEnd = (text: string): string | null => RANGE.exec(text)?.[2] ?? null;

function endDateOf(detail: ItemDetail): string | null {
  if (!RANGE_KINDS.includes(detail.kind)) return null;
  return rangeEnd(detail.text);
}

function dateOf(detail: ItemDetail, timezone: string): string | null {
  if (detail.date !== null || !DATELESS_KINDS.includes(detail.kind)) return detail.date;
  return localDate(detail.firstSeen, timezone);
}

export async function toEvent(detail: ItemDetail, timezone: string): Promise<CalendarEvent> {
  return {
    id: `${detail.kind}:${detail.sourceId}@${await detailHash(detail)}`,
    kind: detail.kind,
    date: dateOf(detail, timezone),
    endDate: endDateOf(detail),
    start: detail.startTime,
    end: detail.endTime,
    title: detail.title,
    text: detail.text,
    sender: detail.sender,
    subject: detail.subject,
    category: detail.category,
    sourceUpdatedAt: detail.sourceUpdatedAt?.toISOString() ?? null,
    firstSeen: detail.firstSeen.toISOString(),
  };
}

const byDate = (a: CalendarEvent, b: CalendarEvent): number => (a.date ?? "").localeCompare(b.date ?? "");

export function sortEvents(events: CalendarEvent[]): CalendarEvent[] {
  return events.sort((a, b) => a.firstSeen.localeCompare(b.firstSeen) || byDate(a, b));
}
