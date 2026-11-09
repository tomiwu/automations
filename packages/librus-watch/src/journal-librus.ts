import { addDays, localDate } from "@automations/shared";
import { checkEvent, planEvents } from "@automations/librus-data";
import type { Classifier, JournalEvent, Observed, StorageAdapter } from "@automations/librus-data";
import { TEST_CATEGORY } from "./lessons.ts";
import { matchLesson } from "./upcoming.ts";
import { TIMETABLE_DAYS, WINDOW_DAYS } from "./source.ts";
import type { HomeworkItem, Lesson, LibrusSource } from "./types.ts";

const SOURCE = "librus-watch";

export interface LibrusJournalDeps {
  storage: StorageAdapter;
  familyId: string;
  childId: string;
  source: LibrusSource;
  timezone: string;
  now: Date;
  /** The homework Items of this run. Missing when the `homework` Watcher failed. */
  homework?: readonly HomeworkItem[];
  log?: (message: string) => void;
}

type LessonState = Pick<Lesson, "date" | "period" | "start" | "end" | "subject" | "teacher" | "room" | "status" | "substituteTeacher">;

type HomeworkState = {
  librusId: string;
  category: string;
  isTest: boolean;
  date: string;
  subject: string;
  content: string;
  teacher: string;
  lessonNo: string | null;
  start: string | null;
  end: string | null;
};

const lessonStream = (childId: string, date: string, period: number) => `lesson:${childId}:${date}:${period}`;
const homeworkStream = (childId: string, id: string) => `homework:${childId}:${id}`;

function lessonState(lesson: Lesson): LessonState {
  const { date, period, start, end, subject, teacher, room, status, substituteTeacher } = lesson;
  return { date, period, start, end, subject, teacher, room, status, substituteTeacher };
}

function addedLesson(state: LessonState): string {
  if (state.status === "cancelled") return "LessonCancelled";
  return state.status === "substitution" ? "LessonSubstituted" : "LessonScheduled";
}

function isSubstitutedNow(previous: LessonState, next: LessonState): boolean {
  return next.status === "substitution" && (previous.status !== "substitution" || previous.substituteTeacher !== next.substituteTeacher);
}

const isCancelledNow = (previous: LessonState, next: LessonState): boolean =>
  next.status === "cancelled" && previous.status !== "cancelled";

const isRestoredNow = (previous: LessonState, next: LessonState): boolean =>
  next.status === "normal" && previous.status !== "normal";

function changedLesson(previous: LessonState, next: LessonState): string {
  if (isCancelledNow(previous, next)) return "LessonCancelled";
  if (isSubstitutedNow(previous, next)) return "LessonSubstituted";
  return isRestoredNow(previous, next) ? "LessonRestored" : "LessonChanged";
}

const LESSON_TYPES: Classifier<LessonState> = { added: addedLesson, changed: changedLesson, vanished: "LessonVanished" };
const HOMEWORK_TYPES: Classifier<HomeworkState> = {
  added: () => "HomeworkAdded",
  changed: () => "HomeworkChanged",
  vanished: "HomeworkVanished",
};

const inDays = (head: JournalEvent, from: string, to?: string): boolean =>
  head.day !== null && head.day >= from && (to === undefined || head.day <= to);

function lessonsObserved(childId: string, lessons: readonly Lesson[]): Observed<LessonState>[] {
  return lessons.map((lesson) => ({
    stream: lessonStream(childId, lesson.date, lesson.period),
    childId,
    kind: "lesson",
    day: lesson.date,
    state: lessonState(lesson),
  }));
}

type Slot = Pick<HomeworkState, "lessonNo" | "start" | "end">;

const slotOf = (item: HomeworkItem, lessons: readonly Lesson[]): Slot => {
  const lesson = matchLesson(item, lessons);
  return { lessonNo: lesson ? String(lesson.period) : null, start: lesson?.start || null, end: lesson?.end || null };
};

const slotOfHead = (head?: JournalEvent): Slot => {
  const { lessonNo = null, start = null, end = null } = (head?.payload ?? {}) as Partial<Slot>;
  return { lessonNo, start, end };
};

function homeworkObserved(
  childId: string,
  items: readonly HomeworkItem[],
  lessons: readonly Lesson[] | undefined,
  heads: ReadonlyMap<string, JournalEvent>,
): Observed<HomeworkState>[] {
  return items.map((item) => {
    const stream = homeworkStream(childId, item.id);
    const { id, category, date, subject, content, teacher } = item;
    const slot = lessons ? slotOf(item, lessons) : slotOfHead(heads.get(stream));
    const state = { librusId: id, category, isTest: TEST_CATEGORY.test(category), date, subject, content, teacher, ...slot };
    return { stream, childId, kind: "homework", day: date, state };
  });
}

const checkStream = (childId: string) => `check:${SOURCE}:${childId}`;

async function readHeads(deps: LibrusJournalDeps, today: string, observed: readonly string[]): Promise<Map<string, JournalEvent>> {
  const { storage, familyId, childId } = deps;
  const first = await storage.listHeads(familyId, { childId, kinds: ["lesson", "homework"], from: addDays(today, -WINDOW_DAYS) });
  const heads = new Map(first.map((head) => [head.stream, head]));
  const missing = observed.filter((stream) => !heads.has(stream));
  const second = await storage.listHeads(familyId, { streams: [checkStream(childId), ...missing] });
  for (const head of second) heads.set(head.stream, head);
  return heads;
}

const headsOf = (heads: ReadonlyMap<string, JournalEvent>, kind: string): JournalEvent[] =>
  [...heads.values()].filter((head) => head.kind === kind);

const streamsOf = (childId: string, down: Downloads): string[] => [
  ...(down.lessons ?? []).map((lesson) => lessonStream(childId, lesson.date, lesson.period)),
  ...(down.homework ?? []).map((item) => homeworkStream(childId, item.id)),
];

/** What the run read. A part that is `undefined` failed or did not run. */
interface Downloads {
  lessons: readonly Lesson[] | undefined;
  homework: readonly HomeworkItem[] | undefined;
}

const planWith = <S,>(
  deps: LibrusJournalDeps,
  heads: JournalEvent[],
  observed: Observed<S>[],
  inVanishScope: (head: JournalEvent) => boolean,
  classify: Classifier<S>,
) => planEvents({ familyId: deps.familyId, source: SOURCE, heads, observed, inVanishScope, classify });

async function planParts(deps: LibrusJournalDeps, today: string, down: Downloads, heads: Map<string, JournalEvent>) {
  const { childId } = deps;
  const lessonScope = (head: JournalEvent) => inDays(head, today, addDays(today, TIMETABLE_DAYS - 1));
  const homeworkScope = (head: JournalEvent) => inDays(head, addDays(today, -WINDOW_DAYS));
  const lessons = down.lessons ? lessonsObserved(childId, down.lessons) : [];
  const homework = down.homework ? homeworkObserved(childId, down.homework, down.lessons, heads) : [];
  const events = [
    ...(down.lessons ? await planWith(deps, headsOf(heads, "lesson"), lessons, lessonScope, LESSON_TYPES) : []),
    ...(down.homework ? await planWith(deps, headsOf(heads, "homework"), homework, homeworkScope, HOMEWORK_TYPES) : []),
  ];
  const payload = { timetableOk: down.lessons !== undefined, homeworkOk: down.homework !== undefined, lessons: lessons.length, homework: homework.length };
  const head = heads.get(checkStream(childId));
  const check = await checkEvent({ familyId: deps.familyId, childId, stream: checkStream(childId), source: SOURCE, day: today, head, payload });
  return [...events, check];
}

/**
 * Appends the Lesson and homework Journal events of one Child. It uses only data that the run read
 * already: the memoized timetable and the homework Items. A failed part gives no event and no vanished
 * event. Returns the number of appended events.
 */
export async function appendLibrusJournal(deps: LibrusJournalDeps): Promise<number> {
  const today = localDate(deps.now, deps.timezone);
  const timetable = await deps.source.fullTimetable();
  const down: Downloads = { lessons: timetable.error === undefined ? timetable.lessons : undefined, homework: deps.homework };
  if (down.lessons === undefined && down.homework === undefined) return 0;
  const streams = streamsOf(deps.childId, down);
  const heads = await readHeads(deps, today, streams);
  const count = await deps.storage.appendEvents(await planParts(deps, today, down, heads));
  deps.log?.(`journal: +${count} events`);
  return count;
}
