import { addDays } from "@automations/shared";
import type { HomeworkItem, Lesson, LibrusSource } from "./types.ts";

/** One upcoming Terminarz entry. It sits on its Lesson when the timetable has one. */
export interface UpcomingEntry {
  childId: string;
  child: string;
  id: string;
  category: string;
  date: string;
  subject: string;
  content: string;
  teacher: string;
  lessonNo: string | null;
  /** "HH:MM" local, or null when no Lesson matches. Then the entry is for the whole day. */
  start: string | null;
  end: string | null;
}

export interface Upcoming {
  childId: string;
  child: string;
  from: string;
  to: string;
  timetableOk: boolean;
  entries: UpcomingEntry[];
  lessons: Lesson[];
}

/** The Child that an upcoming list is for. */
export interface ChildRef {
  id: string;
  name: string;
}

/** Normalizes a subject for comparison: lower case, one space between words. */
export const norm = (subject: string): string => subject.toLocaleLowerCase("pl").replace(/\s+/g, " ").trim();

/** Returns the first Lesson of the subject on that day that was not cancelled. */
export function matchLesson(homework: HomeworkItem, lessons: readonly Lesson[]): Lesson | undefined {
  if (homework.subject === "") return undefined;
  return lessons
    .filter((l) => l.date === homework.date && l.status !== "cancelled" && norm(l.subject) === norm(homework.subject))
    .sort((a, b) => a.period - b.period)[0];
}

export function toUpcoming(child: ChildRef, homework: HomeworkItem, lessons: readonly Lesson[]): UpcomingEntry {
  const lesson = matchLesson(homework, lessons);
  return {
    childId: child.id,
    child: child.name,
    id: homework.id,
    category: homework.category,
    date: homework.date,
    subject: homework.subject,
    content: homework.content,
    teacher: homework.teacher,
    lessonNo: lesson ? String(lesson.period) : null,
    start: lesson?.start || null,
    end: lesson?.end || null,
  };
}

const byDateThenStart = (a: UpcomingEntry, b: UpcomingEntry): number =>
  a.date.localeCompare(b.date) || (a.start ?? "99").localeCompare(b.start ?? "99");

/** Returns the homework and tests dated `from` to `from + days`, each with its matched Lesson. */
export async function upcoming(
  source: LibrusSource,
  options: { child: ChildRef; from: string; days: number },
): Promise<Upcoming> {
  const { child, from, days } = options;
  const to = addDays(from, days);
  const homework = (await source.currentItems("homework", from)).filter((h) => h.date >= from && h.date <= to);
  const { lessons, error } = await source.timetable(from, to);
  const entries = homework.map((h) => toUpcoming(child, h, lessons)).sort(byDateThenStart);
  return { childId: child.id, child: child.name, from, to, timetableOk: error === undefined, entries, lessons };
}
