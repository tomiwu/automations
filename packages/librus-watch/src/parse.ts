import * as cheerio from "cheerio";
import type {
  AnnouncementItem,
  GradeItem,
  Lesson,
  MessageItem,
  TripItem,
} from "./types.ts";

type Json = Record<string, unknown>;

export const clean = (text: string): string => text.replace(/\s+/g, " ").trim();

export const day = (value: unknown): string => (typeof value === "string" ? value.slice(0, 10) : "");
export const time = (value: unknown): string => (typeof value === "string" ? value.slice(0, 5) : "");
const text = (value: unknown): string => clean(String(value ?? ""));

/** Returns the ID in a reference such as `{ Id: 5 }`, or an empty string. */
export const idOf = (ref: unknown): string =>
  ref === undefined || ref === null ? "" : String((ref as { Id?: unknown }).Id ?? "");

function arrayAt(json: string, field: string): Json[] {
  const data: unknown = (JSON.parse(json) as Json)[field];
  if (!Array.isArray(data)) throw new Error(`Librus: unexpected response (no ${field} array)`);
  return data as Json[];
}

export function parseGrades(html: string): GradeItem[] {
  const $ = cheerio.load(html);
  const byId = new Map<string, GradeItem>();
  $("a.ocena").each((_, link) => {
    const id = $(link).attr("href")?.match(/szczegoly\/(\d+)/)?.[1];
    if (!id || /^0+$/.test(id) || byId.has(id)) return;
    const subject = clean($(link).closest("tr").children("td").eq(1).text());
    byId.set(id, { id, subject, grade: clean($(link).text()) });
  });
  return [...byId.values()].filter((grade) => grade.subject !== "");
}

export function parseMessages(html: string): MessageItem[] {
  const $ = cheerio.load(html);
  const items: MessageItem[] = [];
  $("input.wiadomoscLista").each((_, input) => {
    const id = $(input).attr("value");
    if (!id) return;
    const cells = $(input).closest("tr").children("td");
    items.push({
      id,
      sender: clean(cells.eq(2).text()).replace(/\s*\([^)]*\)/, ""),
      subject: clean(cells.eq(3).text()),
      sentAt: clean(cells.eq(4).text()),
    });
  });
  return items;
}

/** Returns the text of an opened message. Line breaks stay. Blank lines are limited to one. */
export function parseMessageBody(html: string): string {
  const $ = cheerio.load(html);
  const element = $(".container-message-content").first();
  element.find("br").replaceWith("\n");
  element.find("p, div").each((_, block) => {
    $(block).append("\n");
  });
  return element
    .text()
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function announcementFields($: cheerio.CheerioAPI, table: Parameters<cheerio.CheerioAPI>[0]): Record<string, string> {
  const fields: Record<string, string> = {};
  $(table)
    .find("tbody tr")
    .each((_, row) => {
      const label = clean($(row).find("th").first().text());
      if (label) fields[label] = clean($(row).find("td").first().text());
    });
  return fields;
}

/** Librus gives no announcement ID, so the ID is the publication time and the title. */
export function parseAnnouncements(html: string): AnnouncementItem[] {
  const $ = cheerio.load(html);
  const items: AnnouncementItem[] = [];
  $("div.container-background table.decorated").each((_, table) => {
    const title = clean($(table).find("thead").text());
    if (!title) return;
    const fields = announcementFields($, table);
    const body = fields["Treść"] ?? "";
    items.push({
      id: `${fields["Czas publikacji"] ?? ""}|${title}`,
      title,
      summary: body.length > 140 ? `${body.slice(0, 140)}…` : body,
    });
  });
  return items;
}

/** Trips from a `SchoolTrips` answer: a `Data` array with lowercase keys. */
export function parseTrips(json: string): TripItem[] {
  return arrayAt(json, "Data").map((trip) => ({
    id: String(trip.id),
    destination: text(trip.destination),
    route: text(trip.route),
    transport: text(trip.locomotion),
    from: day(trip.termFrom),
    to: day(trip.termTo) || day(trip.termFrom),
    coordinator: text(trip.coordinatorName),
  }));
}

/** A HomeWorks entry as Librus sends it: category, subject and teacher are still IDs. */
export interface RawHomework {
  id: string;
  content: string;
  date: string;
  categoryId: string;
  subjectId: string;
  teacherId: string;
}

export function parseHomeworks(json: string): RawHomework[] {
  return arrayAt(json, "HomeWorks").map((entry) => ({
    id: String(entry.Id),
    content: text(entry.Content),
    date: day(entry.Date),
    categoryId: idOf(entry.Category),
    subjectId: idOf(entry.Subject),
    teacherId: idOf(entry.CreatedBy),
  }));
}

/** A teacher absence as Librus sends it: the teacher is still an ID. */
export interface RawAbsence {
  id: string;
  teacherId: string;
  from: string;
  to: string;
  timeFrom: string;
  timeTo: string;
  addedAt: string;
}

function absenceOf(entry: Json): RawAbsence {
  const from = day(entry.DateFrom);
  return {
    id: String(entry.Id),
    teacherId: idOf(entry.Teacher),
    from,
    to: day(entry.DateTo) || from,
    timeFrom: time(entry.TimeFrom),
    timeTo: time(entry.TimeTo),
    addedAt: day(entry.AddDate),
  };
}

/** Absences from a `TeacherFreeDays` answer. One entry covers the whole range of an absence. */
export function parseAbsences(json: string): RawAbsence[] {
  return arrayAt(json, "TeacherFreeDays").map(absenceOf);
}

/** A substitution as Librus sends it: subjects and teachers are still IDs. */
export interface RawSubstitution {
  id: string;
  date: string;
  lessonNo: string;
  orgSubjectId: string;
  orgTeacherId: string;
  subjectId: string;
  teacherId: string;
  classroom: string;
  cancelled: boolean;
}

export function parseSubstitutions(json: string): RawSubstitution[] {
  return arrayAt(json, "Substitutions").map((entry) => ({
    id: String(entry.Id),
    date: day(entry.OrgDate),
    lessonNo: String(entry.OrgLessonNo ?? ""),
    orgSubjectId: idOf(entry.OrgSubject),
    orgTeacherId: idOf(entry.OrgTeacher),
    subjectId: idOf(entry.Subject),
    teacherId: idOf(entry.Teacher),
    classroom: text(entry.ClassroomSymbol),
    cancelled: entry.IsCancelled === true,
  }));
}

export const personName = (person: unknown): string => {
  const { FirstName, LastName } = (person ?? {}) as { FirstName?: unknown; LastName?: unknown };
  return clean(`${FirstName ?? ""} ${LastName ?? ""}`);
};

function lessonStatus(lesson: Json): Lesson["status"] {
  if (lesson.IsCanceled === true) return "cancelled";
  return lesson.IsSubstitutionClass === true ? "substitution" : "normal";
}

/** For a substitution `Teacher` is the substitute and `OrgTeacher` is the planned teacher. */
function lessonTeachers(lesson: Json): Pick<Lesson, "teacher" | "substituteTeacher"> {
  const current = personName(lesson.Teacher);
  if (lesson.IsSubstitutionClass !== true) return { teacher: current, substituteTeacher: "" };
  return { teacher: personName(lesson.OrgTeacher) || current, substituteTeacher: current };
}

function lessonOf(date: string, lesson: Json): Lesson {
  const subject = lesson.Subject as Json | undefined;
  const room = lesson.Classroom as Json | undefined;
  return {
    date,
    period: Number(lesson.LessonNo),
    start: time(lesson.HourFrom),
    end: time(lesson.HourTo),
    subject: text(subject?.Name),
    room: text(room?.Symbol),
    status: lessonStatus(lesson),
    ...lessonTeachers(lesson),
  };
}

/** Lessons from a `Timetables` answer. `Timetable` maps each date to its periods. A free period is an empty list. */
export function parseTimetable(json: string): Lesson[] {
  const days: unknown = (JSON.parse(json) as Json).Timetable;
  if (typeof days !== "object" || days === null) {
    throw new Error("Librus: unexpected response (no Timetable object)");
  }
  return Object.entries(days).flatMap(([date, periods]) =>
    (periods as Json[][]).flat().map((lesson) => lessonOf(date, lesson)),
  );
}
