import { addDays, localDate, weekdayOf, type Account, type Runtime } from "@automations/shared";
import {
  clean,
  parseAbsences,
  parseAnnouncements,
  parseClassFreeDays,
  parseGrades,
  parseHomeworks,
  parseMessageAttachments,
  unrecognizedAttachments,
  parseMessageBody,
  parseMessages,
  parseParentTeacherConferences,
  parseSchoolFreeDays,
  parseSubstitutions,
  parseTimetable,
  parseTrips,
  type RawAbsence,
  type RawDayOff,
  type RawMeeting,
  type RawHomework,
  type RawSubstitution,
} from "./parse.ts";
import { createNameCache, type NameCache, type NameCacheOptions } from "./names-cache.ts";
import { LibrusSession, LibrusTimeoutError, type SessionOptions } from "./session.ts";
import type {
  AbsenceItem,
  DayOffItem,
  HomeworkItem,
  ItemsByWatcher,
  Lesson,
  LessonItem,
  LibrusSource,
  MeetingItem,
  SubstitutionItem,
  TimetableResult,
  WatcherName,
} from "./types.ts";

/** Days the timetable looks ahead, today included. */
export const TIMETABLE_DAYS = 14;
/** Days the Terminarz Watchers look back from today. */
export const WINDOW_DAYS = 7;

type NameKind = "Users" | "Subjects" | "Categories";
type NameLookup = (kind: NameKind, id: string) => Promise<string>;
type Fetcher<W extends WatcherName> = (
  session: LibrusSession,
  since: string,
  names: NameLookup,
) => Promise<ItemsByWatcher[W]>;

const NAME_ENDPOINTS: Record<NameKind, { path: (id: string) => string; name: (json: any) => string | undefined }> = {
  Users: {
    path: (id) => `Users/${id}`,
    name: (json) => (json.User ? clean(`${json.User.FirstName ?? ""} ${json.User.LastName ?? ""}`) : undefined),
  },
  Subjects: { path: (id) => `Subjects/${id}`, name: (json) => json.Subject?.Name },
  Categories: { path: (id) => `HomeWorks/Categories/${id}`, name: (json) => json.Category?.Name },
};

async function fetchName(session: LibrusSession, kind: NameKind, id: string, saved?: NameCache): Promise<string> {
  const key = `${kind}/${id}`;
  const stored = await saved?.find(key);
  if (stored !== undefined) return stored;
  const { path, name } = NAME_ENDPOINTS[kind];
  const found = name(JSON.parse(await session.json(path(id))));
  if (!found) throw new Error(`Librus: no name for ${key}`);
  const cleaned = clean(found);
  await saved?.save(key, cleaned);
  return cleaned;
}

/**
 * Resolves the name behind an ID. Each ID is fetched once in a run. A failed lookup is not cached. With a
 * `saved` cache, a name that is less than 7 days old costs no fetch.
 */
function createNameLookup(session: LibrusSession, saved?: NameCache): NameLookup {
  const cache = new Map<string, Promise<string>>();
  return (kind, id) => {
    if (id === "") return Promise.resolve("");
    const key = `${kind}/${id}`;
    const cached = cache.get(key);
    if (cached) return cached;
    const lookup = fetchName(session, kind, id, saved);
    cache.set(key, lookup);
    lookup.catch(() => cache.delete(key));
    return lookup;
  };
}

/** A short fingerprint (FNV-1a as hex). It is not for security. */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return (hash >>> 0).toString(16);
}

async function resolveHomework(raw: RawHomework, names: NameLookup): Promise<HomeworkItem> {
  const [category, subject, teacher] = await Promise.all([
    names("Categories", raw.categoryId),
    names("Subjects", raw.subjectId),
    names("Users", raw.teacherId),
  ]);
  const hash = fingerprint([raw.content, raw.date, raw.categoryId].join("\u0000"));
  return { id: raw.id, hash, category, date: raw.date, content: raw.content, subject, teacher };
}

async function resolveAbsence(raw: RawAbsence, names: NameLookup): Promise<AbsenceItem> {
  const hash = fingerprint([raw.from, raw.to, raw.timeFrom, raw.timeTo].join("\u0000"));
  const { teacherId, ...rest } = raw;
  return { ...rest, hash, teacher: await names("Users", teacherId) };
}

async function resolveSubstitution(raw: RawSubstitution, names: NameLookup): Promise<SubstitutionItem> {
  const [orgSubject, orgTeacher, subject, teacher] = await Promise.all([
    names("Subjects", raw.orgSubjectId),
    names("Users", raw.orgTeacherId),
    names("Subjects", raw.subjectId),
    names("Users", raw.teacherId),
  ]);
  const { id, date, lessonNo, classroom, cancelled } = raw;
  return { id, date, lessonNo, orgSubject, orgTeacher, subject, teacher, classroom, cancelled };
}

async function resolveMeeting(raw: RawMeeting, names: NameLookup): Promise<MeetingItem> {
  const hash = fingerprint([raw.date, raw.start, raw.end, raw.topic, raw.room, raw.teacherId].join("\u0000"));
  const { teacherId, ...rest } = raw;
  return { ...rest, hash, teacher: await names("Users", teacherId) };
}

function dayOffItem(raw: RawDayOff): DayOffItem {
  return { ...raw, hash: fingerprint([raw.from, raw.to, raw.name].join("\u0000")) };
}

const resolveAll = <R, I>(rows: R[], resolve: (row: R, names: NameLookup) => Promise<I>, names: NameLookup) =>
  Promise.all(rows.map((row) => resolve(row, names)));

type FetchedWatcher = Exclude<WatcherName, "lessons">;

const FETCHERS: { [W in FetchedWatcher]: Fetcher<W> } = {
  grades: async (session) => parseGrades(await session.page("/przegladaj_oceny/uczen")),
  messages: async (session) => parseMessages(await session.page("/wiadomosci")),
  announcements: async (session) => parseAnnouncements(await session.page("/ogloszenia")),
  trips: async (session, since) => parseTrips(await session.json("SchoolTrips")).filter((t) => t.to >= since),
  homework: async (session, since, names) => {
    const rows = parseHomeworks(await session.json("HomeWorks")).filter((h) => h.date >= since);
    return resolveAll(rows, resolveHomework, names);
  },
  absences: async (session, since, names) => {
    const rows = parseAbsences(await session.json("Calendars/TeacherFreeDays")).filter((a) => a.to >= since);
    return resolveAll(rows, resolveAbsence, names);
  },
  substitutions: async (session, since, names) => {
    const rows = parseSubstitutions(await session.json("Calendars/Substitutions")).filter((s) => s.date >= since);
    return resolveAll(rows, resolveSubstitution, names);
  },
  meetings: async (session, since, names) => {
    const rows = parseParentTeacherConferences(await session.json("ParentTeacherConferences")).filter((m) => m.date >= since);
    return resolveAll(rows, resolveMeeting, names);
  },
  schoolFreeDays: async (session, since) =>
    parseSchoolFreeDays(await session.json("SchoolFreeDays")).filter((d) => d.to >= since).map(dayOffItem),
  classFreeDays: async (session, since) =>
    parseClassFreeDays(await session.json("ClassFreeDays")).filter((d) => d.to >= since).map(dayOffItem),
};

/** Returns the Monday of each week that has a day between `from` and `to`. */
export function timetableWeeks(from: string, to: string): string[] {
  const weeks: string[] = [];
  for (let week = addDays(from, 1 - weekdayOf(from)); week <= to; week = addDays(week, 7)) weeks.push(week);
  return weeks;
}

async function readTimetable(session: LibrusSession, from: string, to: string): Promise<Lesson[]> {
  const weeks = timetableWeeks(from, to);
  const answers = await Promise.all(weeks.map((week) => session.json(`Timetables?weekStart=${week}`)));
  return answers.flatMap(parseTimetable).filter((lesson) => lesson.date >= from && lesson.date <= to);
}

/** A Lesson as an Item. A cancel or a substitution changes the hash, so it is an updated Item. */
export function lessonItem(lesson: Lesson): LessonItem {
  return { ...lesson, id: `${lesson.date}:${lesson.period}`, hash: `${lesson.status}|${lesson.substituteTeacher}` };
}

export interface LibrusSourceOptions extends SessionOptions {
  /** IANA time zone of the Family. Dates count in this zone. */
  timezone: string;
  /** Where the names of Users, Subjects and Categories are kept between runs. Without it each run fetches them. */
  names?: NameCacheOptions;
}

/**
 * The one interface through which the Watchers see Librus (one Account). It logs in on first use.
 * After a timeout Librus counts as unreachable, so later calls fail fast.
 */
export function createLibrusSource(
  runtime: Runtime,
  account: Pick<Account, "origin" | "login_secret" | "password_secret">,
  options: LibrusSourceOptions,
): LibrusSource {
  const session = new LibrusSession(runtime, account, options);
  const saved = options.names && createNameCache(options.names, () => runtime.now());
  const names = createNameLookup(session, saved);
  let loggedIn: Promise<void> | undefined;
  let unreachable: LibrusTimeoutError | undefined;
  const today = () => localDate(runtime.now(), options.timezone);

  const noteTimeout = (error: unknown): never => {
    if (error instanceof LibrusTimeoutError) unreachable = error;
    throw error;
  };

  const ensureLogin = (): Promise<void> => {
    if (unreachable) return Promise.reject(unreachable);
    loggedIn ??= session.login().catch((error: unknown) => {
      loggedIn = undefined;
      return noteTimeout(error);
    });
    return loggedIn;
  };

  const readOnce = async (from: string, to: string): Promise<TimetableResult> => {
    try {
      await ensureLogin();
      return { lessons: await readTimetable(session, from, to) };
    } catch (error) {
      return { lessons: [], error: error instanceof Error ? error.message : String(error) };
    }
  };

  const timetables = new Map<string, Promise<TimetableResult>>();
  /** One read for each range in the life of the source. A second call with the same range makes no fetch. */
  const timetable = (from: string, to: string): Promise<TimetableResult> => {
    const key = `${from}|${to}`;
    const known = timetables.get(key) ?? readOnce(from, to);
    timetables.set(key, known);
    return known;
  };

  const fullTimetable = (): Promise<TimetableResult> => timetable(today(), addDays(today(), TIMETABLE_DAYS - 1));

  const fetched = async <W extends FetchedWatcher>(watcher: W, since?: string): Promise<ItemsByWatcher[W]> => {
    await ensureLogin();
    const fetcher = FETCHERS[watcher] as Fetcher<W>;
    return fetcher(session, since ?? addDays(today(), -WINDOW_DAYS), names)
      .catch(noteTimeout)
      .finally(() => saved?.flush());
  };

  return {
    async currentItems<W extends WatcherName>(watcher: W, since?: string): Promise<ItemsByWatcher[W]> {
      if (watcher === "lessons") {
        return (await fullTimetable()).lessons.map(lessonItem) as ItemsByWatcher[W];
      }
      return fetched(watcher as FetchedWatcher, since) as Promise<ItemsByWatcher[W]>;
    },
    async messageBody(id) {
      return (await this.openMessage(id)).body;
    },
    async openMessage(id) {
      await ensureLogin();
      const html = await session.page(`/wiadomosci/1/5/${encodeURIComponent(id)}/f0`);
      const attachments = parseMessageAttachments(html);
      return { body: parseMessageBody(html), attachments, unrecognizedAttachments: unrecognizedAttachments(html, attachments) };
    },
    async fetchAttachment(downloadPath) {
      await ensureLogin();
      const path = downloadPath.startsWith("/") ? downloadPath : `/${downloadPath}`;
      const bytes = await session.binary(path);
      return new Uint8Array(bytes);
    },
    fullTimetable,
    timetable,
  };
}
