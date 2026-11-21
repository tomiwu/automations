import { addDays } from "@automations/shared";
import { lessonRecords, type LessonRecord } from "./lessons.ts";
import { TIMETABLE_DAYS } from "./source.ts";
import { toUpcoming, type ChildRef, type UpcomingEntry } from "./upcoming.ts";
import type { LibrusSource } from "./types.ts";

export interface CalendarResult {
  from: string;
  to: string;
  timetableOk: boolean;
  lessons: LessonRecord[];
  entries: UpcomingEntry[];
  error?: string;
}

const byDateThenStart = (a: UpcomingEntry, b: UpcomingEntry): number =>
  a.date.localeCompare(b.date) || (a.start ?? "99").localeCompare(b.start ?? "99");

export async function readCalendar(source: LibrusSource, child: ChildRef, from: string): Promise<CalendarResult> {
  const to = addDays(from, TIMETABLE_DAYS - 1);
  const { lessons, error } = await source.timetable(from, to);
  const base = { from, to, timetableOk: error === undefined };
  if (error !== undefined) return { ...base, lessons: [], entries: [], error };
  const homework = (await source.currentItems("homework", from)).filter((h) => h.date >= from && h.date <= to);
  const entries = homework.map((h) => toUpcoming(child, h, lessons)).sort(byDateThenStart);
  return { ...base, lessons: lessonRecords(child, lessons, homework), entries };
}
