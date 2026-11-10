/**
 * Read-only check after a days-off deploy: the Journal has the day-off Items of a date range and `./stored-lessons`
 * marks the Lessons of those days `cancelled` with `cancelReason.reason = "day_off"`. It uses the same read paths as
 * the calendar sync (`librus-watch ./stored-lessons` and `./stream-history`, Supabase only). It prints no name, no
 * title and no full Child ID.
 */

export interface CheckLesson {
  date: string;
  period: number | string;
  status?: string;
  cancelled?: boolean;
  vanished?: boolean;
  cancelReason?: { reason: string; sourceStream: string; sourceId: string };
}

export interface CheckHistory {
  stream: string;
  events: { kind: string; eventType: string; day: string | null }[];
}

export interface DaysOffInput {
  lastSavedAt: string | null;
  lessons: CheckLesson[];
  histories: CheckHistory[];
}

export interface DaysOffOptions {
  from: string;
  to: string;
  /** The number of Lessons that must be cancelled as day off in the range. */
  expectLessons: number;
}

export interface DaysOffResult {
  ok: boolean;
  lines: string[];
}

/** The day-off Item streams of the producer (`item:<watcher>:<childId>:<id>`, contract 8a D6). */
export const DAY_OFF_STREAM = /^item:(schoolFreeDays|classFreeDays):[^:]+:[^:]+$/;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Hides the full Child ID: only its first 8 characters stay. */
export const mask = (text: string): string => text.replace(UUID, (id) => `${id.slice(0, 8)}…`);

const inRange = (date: string, options: DaysOffOptions): boolean => options.from <= date && date <= options.to;

/** The distinct day-off source streams of the Lessons, in first-seen order. */
export function sourceStreams(lessons: readonly CheckLesson[]): string[] {
  return [...new Set(lessons.flatMap((lesson) => (lesson.cancelReason?.reason === "day_off" ? [lesson.cancelReason.sourceStream] : [])))];
}

function lessonLines(input: DaysOffInput, options: DaysOffOptions): { ok: boolean; lines: string[] } {
  const lessons = input.lessons.filter((lesson) => inRange(lesson.date, options) && !lesson.vanished);
  const dayOff = lessons.filter((lesson) => lesson.cancelled === true && lesson.cancelReason?.reason === "day_off");
  const open = lessons.filter((lesson) => !dayOff.includes(lesson)).map((lesson) => `${lesson.date}#${lesson.period}`);
  const ok = dayOff.length >= options.expectLessons && open.length === 0;
  const lines = [`${ok ? "OK" : "FAIL"} lessons: ${dayOff.length} of ${lessons.length} in ${options.from}..${options.to} cancelled as day_off (expected at least ${options.expectLessons})`];
  if (open.length > 0) lines.push(`FAIL lessons not cancelled as day_off: ${open.join(", ")}`);
  return { ok, lines };
}

function streamLine(stream: string, histories: readonly CheckHistory[]): { ok: boolean; line: string } {
  const history = histories.find((h) => h.stream === stream);
  const items = history?.events.filter((event) => event.kind === "dayOff") ?? [];
  const ok = DAY_OFF_STREAM.test(stream) && items.length > 0;
  return { ok, line: `${ok ? "OK" : "FAIL"} journal ${mask(stream)}: ${items.length} dayOff event(s)${DAY_OFF_STREAM.test(stream) ? "" : " (not an item:schoolFreeDays|classFreeDays stream)"}` };
}

function journalLines(input: DaysOffInput): { ok: boolean; lines: string[] } {
  const streams = sourceStreams(input.lessons).map((stream) => streamLine(stream, input.histories));
  if (streams.length === 0) return { ok: false, lines: ["FAIL journal: no day-off source stream in the Lessons"] };
  return { ok: streams.every((s) => s.ok), lines: streams.map((s) => s.line) };
}

/** Checks the data that the two exports returned. */
export function evaluateDaysOff(input: DaysOffInput, options: DaysOffOptions): DaysOffResult {
  const saved = input.lastSavedAt !== null;
  const lessons = lessonLines(input, options);
  const journal = journalLines(input);
  const savedLine = saved ? `OK lastSavedAt: ${input.lastSavedAt}` : "FAIL lastSavedAt: null (no Journal pass yet)";
  return { ok: saved && lessons.ok && journal.ok, lines: [savedLine, ...lessons.lines, ...journal.lines] };
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";

/** Finds the first object in a CLI answer that has the given key (the CLI may wrap the export result). */
export function unwrap<T>(value: unknown, key: string): T | undefined {
  if (!isObject(value)) return undefined;
  if (key in value) return value as T;
  return Object.values(value).reduce<T | undefined>((found, child) => found ?? unwrap<T>(child, key), undefined);
}
