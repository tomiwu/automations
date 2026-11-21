export type WatcherName =
  | "grades"
  | "messages"
  | "announcements"
  | "trips"
  | "homework"
  | "absences"
  | "substitutions"
  | "lessons"
  | "meetings"
  | "schoolFreeDays"
  | "classFreeDays";

export interface GradeItem {
  id: string;
  subject: string;
  grade: string;
  /** The `Data` value of the grade link, "YYYY-MM-DD", or an empty string. */
  date: string;
  /** The `Kategoria` value, or an empty string. */
  category: string;
  /** The `Nauczyciel` value, or an empty string. */
  teacher: string;
}

export interface MessageItem {
  id: string;
  sender: string;
  subject: string;
  sentAt: string;
}

export interface AnnouncementItem {
  id: string;
  title: string;
  /** The start of the text, for Telegram. */
  summary: string;
  /** The whole `Treść` text. */
  text: string;
  /** The `Czas publikacji` value, for example "2026-01-05 10:30:00". */
  publishedAt: string;
}

/** One school trip from the Terminarz. Dates are "YYYY-MM-DD". */
export interface TripItem {
  id: string;
  destination: string;
  route: string;
  transport: string;
  from: string;
  to: string;
  coordinator: string;
}

/** One Terminarz entry (homework, test, trip, meeting), names already resolved. */
export interface HomeworkItem {
  id: string;
  /** Fingerprint of the meaningful fields. A changed hash makes the entry an updated Item. */
  hash: string;
  category: string;
  date: string;
  content: string;
  subject: string;
  teacher: string;
}

/** One teacher absence: a range of days, reported once. Times are "HH:MM" or empty for whole days. */
export interface AbsenceItem {
  id: string;
  hash: string;
  teacher: string;
  from: string;
  to: string;
  timeFrom: string;
  timeTo: string;
  addedAt: string;
}

/** One lesson substitution, names already resolved. */
export interface SubstitutionItem {
  id: string;
  date: string;
  lessonNo: string;
  orgSubject: string;
  orgTeacher: string;
  subject: string;
  teacher: string;
  classroom: string;
  cancelled: boolean;
}

/** One parent-teacher meeting. Date is "YYYY-MM-DD", times are "HH:MM" or empty when Librus gave none. */
export interface MeetingItem {
  id: string;
  /** Fingerprint of the meaningful fields. A changed hash makes the meeting an updated Item. */
  hash: string;
  date: string;
  start: string;
  end: string;
  topic: string;
  room: string;
  teacher: string;
}

/** One day off, for the whole school or for the class: a date range. Dates are "YYYY-MM-DD". */
export interface DayOffItem {
  id: string;
  hash: string;
  from: string;
  to: string;
  name: string;
}

/** One period of the timetable. */
export interface Lesson {
  date: string;
  period: number;
  start: string;
  end: string;
  subject: string;
  teacher: string;
  room: string;
  status: "normal" | "cancelled" | "substitution";
  /** Teacher who gives a substituted Lesson. Empty for the other statuses. */
  substituteTeacher: string;
}

/** A Lesson as a Watcher Item. The hash covers the status and the substitute teacher. */
export interface LessonItem extends Lesson {
  id: string;
  hash: string;
}

/** The timetable, or an empty list and the reason when Librus gave none. */
export interface TimetableResult {
  lessons: Lesson[];
  error?: string;
}

export interface ItemsByWatcher {
  grades: GradeItem[];
  messages: MessageItem[];
  announcements: AnnouncementItem[];
  trips: TripItem[];
  homework: HomeworkItem[];
  absences: AbsenceItem[];
  substitutions: SubstitutionItem[];
  lessons: LessonItem[];
  meetings: MeetingItem[];
  schoolFreeDays: DayOffItem[];
  classFreeDays: DayOffItem[];
}

export interface LibrusSource {
  /** Current Items of one Watcher. The Terminarz Watchers keep entries that end on or after `since`. */
  currentItems<W extends WatcherName>(watcher: W, since?: string): Promise<ItemsByWatcher[W]>;
  /** Whole body of a message. Opening a message marks it read in Librus. */
  messageBody(id: string): Promise<string>;
  /** Lessons of the next 14 days. It never rejects: on a failure the list is empty and `error` says why. */
  fullTimetable(): Promise<TimetableResult>;
  /** Lessons from `from` to `to`, both "YYYY-MM-DD". It never rejects: on a failure the list is empty and `error` says why. */
  timetable(from: string, to: string): Promise<TimetableResult>;
}
