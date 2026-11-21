import type { HomeworkItem, Lesson, LibrusSource } from "./types.ts";
import { norm, type ChildRef } from "./upcoming.ts";

/** A homework entry given at a Lesson. */
export interface HomeworkNote {
  category: string;
  content: string;
  teacher: string;
}

/** A test or quiz at a later Lesson. */
export interface TestNote {
  date: string;
  period: number;
  category: string;
  content: string;
}

/** One Lesson as the calendar agent reads it. */
export interface LessonRecord extends Lesson {
  /** A stable key: Child, date and period. The agent updates one calendar event with it. */
  id: string;
  childId: string;
  child: string;
  homeworkGiven: HomeworkNote[];
  /** Tests and quizzes at the next Lesson of the same subject. */
  testAtNextLesson: TestNote[];
}

/** The result of the export. `error` is set only when Librus gave no timetable. */
export interface LessonsResult {
  lessons: LessonRecord[];
  error?: string;
}

export const TEST_CATEGORY = /sprawdzian|kartk[oó]wk|praca klasowa|\btest\b|quiz|klask[oó]wk/i;

const isTest = (homework: HomeworkItem): boolean => TEST_CATEGORY.test(homework.category);
const sameSubject = (homework: HomeworkItem, lesson: Lesson): boolean =>
  homework.subject !== "" && norm(homework.subject) === norm(lesson.subject);
const sameLessonSubject = (a: Lesson, b: Lesson): boolean => norm(a.subject) === norm(b.subject);
const isBefore = (a: Lesson, b: Lesson): boolean => a.date < b.date || (a.date === b.date && a.period < b.period);
const byTime = (a: Lesson, b: Lesson): number => (isBefore(a, b) ? -1 : isBefore(b, a) ? 1 : 0);

function homeworkGiven(lesson: Lesson, sorted: Lesson[], homework: HomeworkItem[]): HomeworkNote[] {
  const first = sorted.find((n) => n.status !== "cancelled" && n.date === lesson.date && sameLessonSubject(n, lesson));
  if (first !== lesson) return [];
  return homework
    .filter((h) => !isTest(h) && h.date === lesson.date && sameSubject(h, lesson))
    .map(({ category, content, teacher }) => ({ category, content, teacher }));
}

function testAtNextLesson(lesson: Lesson, sorted: Lesson[], homework: HomeworkItem[]): TestNote[] {
  const next = sorted.find((n) => n.status !== "cancelled" && sameLessonSubject(n, lesson) && isBefore(lesson, n));
  if (!next) return [];
  return homework
    .filter((h) => isTest(h) && h.date === next.date && sameSubject(h, next))
    .map((h) => ({ date: next.date, period: next.period, category: h.category, content: h.content }));
}

/** Returns one record for each Lesson, ordered by date and period. */
export function lessonRecords(child: ChildRef, lessons: Lesson[], homework: HomeworkItem[]): LessonRecord[] {
  const sorted = [...lessons].sort(byTime);
  return sorted.map((lesson) => ({
    ...lesson,
    id: `${child.id}:${lesson.date}:${lesson.period}`,
    childId: child.id,
    child: child.name,
    homeworkGiven: homeworkGiven(lesson, sorted, homework),
    testAtNextLesson: testAtNextLesson(lesson, sorted, homework),
  }));
}

/** Reads the timetable and the homework. A missing timetable gives an empty result with an `error`. */
export async function readLessons(source: LibrusSource, child: ChildRef): Promise<LessonsResult> {
  const { lessons, error } = await source.fullTimetable();
  if (lessons.length === 0) return error === undefined ? { lessons: [] } : { lessons: [], error };
  const from = lessons.map((l) => l.date).sort()[0] ?? "";
  return { lessons: lessonRecords(child, lessons, await source.currentItems("homework", from)) };
}
