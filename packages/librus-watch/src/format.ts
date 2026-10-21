import { t, type Language } from "@automations/shared";
import type {
  AbsenceItem,
  AnnouncementItem,
  GradeItem,
  HomeworkItem,
  LessonItem,
  MessageItem,
  SubstitutionItem,
  TripItem,
} from "./types.ts";

/** What a Notification is about: an Item seen the first time, or a seen Item that changed. */
export type ItemChange = "new" | "updated";

/** Everything a formatter needs: the language of the Recipient and the name of the Child. */
export interface FormatContext {
  language: Language;
  child: string;
}

const HOMEWORK_TEXT_LIMIT = 300;
const ANNOUNCEMENT_LINE_LIMIT = 200;

const withBody = (head: string, body: string): string => (body.trim() === "" ? head : `${head}\n${body.trim()}`);
const rangeText = (from: string, to: string): string => (to === from ? from : `${from} - ${to}`);
const truncated = (content: string): string =>
  content.length > HOMEWORK_TEXT_LIMIT ? `${content.slice(0, HOMEWORK_TEXT_LIMIT)}…` : content;
const inBrackets = (value: string): string => (value === "" ? "" : ` (${value})`);

export function formatGrade({ language, child }: FormatContext, grade: GradeItem): string {
  return t(language, "grade.new", { child, subject: grade.subject, value: grade.grade });
}

export function formatMessage({ language, child }: FormatContext, message: MessageItem, body: string): string {
  const head = t(language, "message.from", { child, sender: message.sender, subject: message.subject });
  return withBody(head, body);
}

export function formatAnnouncement({ language, child }: FormatContext, announcement: AnnouncementItem): string {
  const head = t(language, "announcement.new", { child, subject: announcement.title });
  const firstLine = announcement.summary.trim().split(/\r?\n/)[0] ?? "";
  return withBody(head, firstLine.slice(0, ANNOUNCEMENT_LINE_LIMIT));
}

export function formatTrip({ language, child }: FormatContext, trip: TripItem): string {
  const head = t(language, "trip.new", { child, dates: rangeText(trip.from, trip.to), destination: trip.destination });
  const details = [
    t(language, "detail.route", { value: trip.route }),
    t(language, "detail.transport", { value: trip.transport }),
    t(language, "detail.coordinator", { value: trip.coordinator }),
  ];
  const values = [trip.route, trip.transport, trip.coordinator];
  return [head, ...details.filter((_, index) => values[index] !== "")].join("\n");
}

export function formatHomework({ language, child }: FormatContext, homework: HomeworkItem, change: ItemChange): string {
  const key = change === "new" ? "entry.new" : "entry.updated";
  const subject = `${homework.subject}${inBrackets(homework.teacher)}`;
  const head = t(language, key, { category: homework.category, child, date: homework.date, subject });
  return withBody(head, truncated(homework.content));
}

/** Returns the teacher, the range and any time span of an absence, as one line. */
function absenceDetails(absence: AbsenceItem): string {
  const span = absence.timeFrom === "" && absence.timeTo === "" ? "" : `${absence.timeFrom}-${absence.timeTo}`;
  return [absence.teacher, rangeText(absence.from, absence.to), span].filter((part) => part !== "").join(", ");
}

export function formatAbsence({ language, child }: FormatContext, absence: AbsenceItem, change: ItemChange): string {
  const key = change === "new" ? "absence.new" : "absence.updated";
  const head = t(language, key, { child, details: absenceDetails(absence) });
  return absence.addedAt === "" ? head : `${head}\n${t(language, "absence.added", { date: absence.addedAt })}`;
}

/** Returns "was -> now", or one of them when the other is empty or the same. */
function replaced(was: string, now: string): string {
  if (now === "" || now === was) return was;
  return was === "" ? now : `${was} -> ${now}`;
}

function substitutionLine(language: Language, item: SubstitutionItem): string {
  const current = item.cancelled ? { subject: "", teacher: "" } : item;
  const subject = replaced(item.orgSubject, current.subject);
  const what = `${subject}${inBrackets(replaced(item.orgTeacher, current.teacher))}`;
  const lesson = item.lessonNo;
  if (item.cancelled) return t(language, "substitution.cancelled", { lesson, what });
  const room = item.classroom === "" ? "" : t(language, "substitution.room", { room: item.classroom });
  return t(language, "substitution.line", { lesson, what, room });
}

const byLesson = (a: SubstitutionItem, b: SubstitutionItem): number => Number(a.lessonNo) - Number(b.lessonNo);

/** One text for all new substitutions of one day. The lessons are in order. */
export function formatSubstitutions({ language, child }: FormatContext, date: string, items: SubstitutionItem[]): string {
  const lines = [...items].sort(byLesson).map((item) => substitutionLine(language, item));
  return [t(language, "substitutions.heading", { child, date }), ...lines].join("\n");
}

export function formatLesson({ language, child }: FormatContext, lesson: LessonItem): string {
  const params = {
    child,
    date: lesson.date,
    period: lesson.period,
    subject: lesson.subject,
    start: lesson.start,
    end: lesson.end,
  };
  if (lesson.status === "cancelled") return t(language, "lesson.cancelled", params);
  const who =
    lesson.substituteTeacher === ""
      ? ""
      : t(language, "lesson.substitute_who", { substitute: lesson.substituteTeacher, teacher: lesson.teacher });
  return t(language, "lesson.substituted", { ...params, who });
}

export function formatAccountError({ language, child }: FormatContext, reason: string): string {
  return t(language, "error.fetch", { child, reason });
}

export function formatLoginError({ language, child }: FormatContext): string {
  return t(language, "error.login", { child });
}
