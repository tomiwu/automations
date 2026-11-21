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
  date: string;
  category: string;
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
  summary: string;
  text: string;
  publishedAt: string;
}

export interface TripItem {
  id: string;
  destination: string;
  route: string;
  transport: string;
  from: string;
  to: string;
  coordinator: string;
}

export interface HomeworkItem {
  id: string;
  hash: string;
  category: string;
  date: string;
  content: string;
  subject: string;
  teacher: string;
}

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

export interface MeetingItem {
  id: string;
  hash: string;
  date: string;
  start: string;
  end: string;
  topic: string;
  room: string;
  teacher: string;
}

export interface DayOffItem {
  id: string;
  hash: string;
  from: string;
  to: string;
  name: string;
}

export interface Lesson {
  date: string;
  period: number;
  start: string;
  end: string;
  subject: string;
  teacher: string;
  room: string;
  status: "normal" | "cancelled" | "substitution";
  substituteTeacher: string;
}

export interface LessonItem extends Lesson {
  id: string;
  hash: string;
}

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
  messageBody(id: string): Promise<string>;
  /** Lessons of the next 14 days. It never rejects: on a failure the list is empty and `error` says why. */
  fullTimetable(): Promise<TimetableResult>;
  /** Lessons from `from` to `to`, both "YYYY-MM-DD". It never rejects: on a failure the list is empty and `error` says why. */
  timetable(from: string, to: string): Promise<TimetableResult>;
}
