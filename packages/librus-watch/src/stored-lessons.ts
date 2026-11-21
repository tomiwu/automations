import { addDays, localDate, type FetchCount } from "@automations/shared";
import { projectHeads, type JournalEvent, type StreamState } from "@automations/librus-data";
import { checkChildId, checkKeys, inputObject, MAX_DAYS, pickTarget, withFetches, type ExportDeps } from "./exports.ts";
import { checkDay, rangeEnd } from "./events.ts";
import { lessonRecords, type HomeworkNote, type TestNote } from "./lessons.ts";
import { librusTargets } from "./run.ts";
import type { HomeworkItem, Lesson } from "./types.ts";

const DEFAULT_SPAN_DAYS = 13;
const DAY_MS = 86_400_000;

export interface CancelReason {
  reason: "day_off";
  sourceStream: string;
  sourceId: string;
}

export interface StoredLesson extends Lesson {
  id: string;
  childId: string;
  stream: string;
  cancelled: boolean;
  vanished: boolean;
  seq: number;
  lastChanged: string;
  homeworkGiven: HomeworkNote[];
  testAtNextLesson: TestNote[];
  cancelReason?: CancelReason;
}

export interface StoredHomework {
  id: string;
  childId: string;
  stream: string;
  category: string;
  isTest: boolean;
  date: string;
  subject: string;
  content: string;
  teacher: string;
  lessonNo: string | null;
  start: string | null;
  end: string | null;
  vanished: boolean;
  seq: number;
  lastChanged: string;
}

export interface StoredLessonsExport {
  childId: string;
  child: string;
  timezone: string;
  from: string;
  to: string;
  lastSavedAt: string | null;
  lastCheck: { timetableOk: boolean; homeworkOk: boolean } | null;
  lessons: StoredLesson[];
  homework: StoredHomework[];
}

interface Range {
  from: string;
  to: string;
}

function resolveRange(object: Record<string, unknown>, today: string): Range {
  const from = checkDay("from", object.from) ?? today;
  const to = checkDay("to", object.to) ?? addDays(from, DEFAULT_SPAN_DAYS);
  const span = (Date.parse(to) - Date.parse(from)) / DAY_MS;
  if (span < 0) throw new Error("to must not be before from.");
  if (span > MAX_DAYS) throw new Error(`to - from must be at most ${MAX_DAYS} days.`);
  return { from, to };
}

function lessonOf(head: StreamState): StoredLesson {
  const { date, period, start, end, subject, teacher, room, status, substituteTeacher } = head.state as unknown as Lesson;
  return {
    id: "", childId: head.childId, stream: head.stream, date, period, start, end, subject, teacher, room, status, substituteTeacher,
    cancelled: status === "cancelled", vanished: head.vanished, seq: head.seq, lastChanged: head.lastChanged.toISOString(), homeworkGiven: [], testAtNextLesson: [],
  };
}

function homeworkOf(head: StreamState): StoredHomework {
  const s = head.state as Record<string, unknown>;
  return {
    id: String(s.librusId), childId: head.childId, stream: head.stream, category: String(s.category), isTest: Boolean(s.isTest), date: String(s.date),
    subject: String(s.subject), content: String(s.content), teacher: String(s.teacher),
    lessonNo: (s.lessonNo as string | null) ?? null, start: (s.start as string | null) ?? null, end: (s.end as string | null) ?? null,
    vanished: head.vanished, seq: head.seq, lastChanged: head.lastChanged.toISOString(),
  };
}

const byDateThenStart = (a: StoredHomework, b: StoredHomework): number =>
  a.date.localeCompare(b.date) || (a.start ?? "").localeCompare(b.start ?? "") || a.id.localeCompare(b.id);

const asItem = (h: StoredHomework): HomeworkItem => ({ id: h.id, hash: "", category: h.category, date: h.date, content: h.content, subject: h.subject, teacher: h.teacher });

function withNotes(child: { id: string; name: string }, lessons: StoredLesson[], homework: StoredHomework[]): StoredLesson[] {
  const live = lessons.filter((lesson) => !lesson.vanished);
  const notes = new Map(lessonRecords(child, live, homework.filter((h) => !h.vanished).map(asItem)).map((record) => [record.id, record]));
  return lessons.map((lesson) => {
    const id = `${child.id}:${lesson.date}:${lesson.period}`;
    const note = notes.get(id);
    return { ...lesson, id, homeworkGiven: note?.homeworkGiven ?? [], testAtNextLesson: note?.testAtNextLesson ?? [] };
  });
}

interface DayOff {
  from: string;
  to: string;
  reason: CancelReason;
}

function dayOffRange(date: string, text: string | undefined): Pick<DayOff, "from" | "to"> {
  const end = rangeEnd(text ?? "") ?? date;
  return { from: date, to: end < date ? date : end };
}

function dayOffOf(head: StreamState): DayOff | null {
  const { date, text, sourceId, withdrawn } = head.state as { date?: string | null; text?: string; sourceId?: string; withdrawn?: boolean };
  if (head.vanished || withdrawn === true || !date || sourceId === undefined) return null;
  return { ...dayOffRange(date, text), reason: { reason: "day_off", sourceStream: head.stream, sourceId: String(sourceId) } };
}

function withDaysOff(lessons: StoredLesson[], daysOff: DayOff[]): StoredLesson[] {
  return lessons.map((lesson) => {
    const dayOff = daysOff.find((d) => d.from <= lesson.date && lesson.date <= d.to);
    if (!dayOff) return lesson;
    return { ...lesson, status: "cancelled", cancelled: true, cancelReason: dayOff.reason };
  });
}

function checkOf(heads: JournalEvent[]): Pick<StoredLessonsExport, "lastSavedAt" | "lastCheck"> {
  const [head] = heads;
  if (!head) return { lastSavedAt: null, lastCheck: null };
  const payload = head.payload as { timetableOk?: boolean; homeworkOk?: boolean };
  return {
    lastSavedAt: head.recordedAt.toISOString(),
    lastCheck: { timetableOk: payload.timetableOk === true, homeworkOk: payload.homeworkOk === true },
  };
}

export async function storedLessonsExport(deps: ExportDeps, input: unknown = {}): Promise<StoredLessonsExport & { fetches?: FetchCount }> {
  const object = inputObject(input);
  checkKeys(object, ["childId", "from", "to"]);
  const childId = checkChildId(object.childId);
  const config = await deps.storage.loadConfig(deps.familyId);
  const { child } = pickTarget(librusTargets(config).targets, childId);
  const timezone = config.family.timezone;
  const { from, to } = resolveRange(object, localDate(deps.runtime.now(), timezone));
  const heads = await deps.storage.listHeads(deps.familyId, { childId: child.id, kinds: ["lesson", "homework"], from, to });
  const checks = await deps.storage.listHeads(deps.familyId, { streams: [`check:librus-watch:${child.id}`] });
  const dayOffHeads = await deps.storage.listHeads(deps.familyId, { childId: child.id, kinds: ["dayOff"], to });
  const daysOff = projectHeads(dayOffHeads).map(dayOffOf).filter((d): d is DayOff => d !== null && d.to >= from);
  const headsOfKind = (kind: string) => projectHeads(heads.filter((head) => head.kind === kind));
  const homework = headsOfKind("homework").map(homeworkOf).sort(byDateThenStart);
  const lessons = headsOfKind("lesson")
    .map(lessonOf)
    .sort((a, b) => a.date.localeCompare(b.date) || a.period - b.period);
  return withFetches(deps, {
    childId: child.id, child: child.name, timezone, from, to, ...checkOf(checks),
    lessons: withDaysOff(withNotes(child, lessons, homework), daysOff), homework,
  });
}
