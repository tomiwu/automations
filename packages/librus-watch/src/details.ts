import type { ItemKind, NewItemDetail } from "@automations/librus-data";
import type {
  AnnouncementItem,
  DayOffItem,
  GradeItem,
  HomeworkItem,
  MeetingItem,
  ItemsByWatcher,
  MessageItem,
  TripItem,
  WatcherName,
} from "./types.ts";

export interface DetailContext {
  familyId: string;
  scope: string;
  childId: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/;

const dayOf = (value: string): string | null =>
  value.match(DATE_PATTERN)?.[0] ?? null;

function momentOf(value: string): Date | null {
  if (!DATE_PATTERN.test(value)) return null;
  const moment = new Date(
    `${value.slice(0, 10)}T${value.slice(11, 19) || "00:00:00"}Z`,
  );
  return Number.isNaN(moment.getTime()) ? null : moment;
}

const orNull = (value: string): string | null => (value === "" ? null : value);

const emptyDetail = (
  context: DetailContext,
  kind: ItemKind,
  sourceId: string,
): NewItemDetail => ({
  ...context,
  kind,
  sourceId,
  date: null,
  startTime: null,
  endTime: null,
  title: "",
  text: "",
  sender: null,
  subject: null,
  category: null,
  sourceUpdatedAt: null,
});

export function messageDetail(
  context: DetailContext,
  message: MessageItem,
  body: string,
): NewItemDetail {
  return {
    ...emptyDetail(context, "message", message.id),
    date: dayOf(message.sentAt),
    title: message.subject,
    text: body,
    sender: message.sender,
    subject: message.subject,
    sourceUpdatedAt: momentOf(message.sentAt),
  };
}

export function announcementDetail(
  context: DetailContext,
  announcement: AnnouncementItem,
): NewItemDetail {
  return {
    ...emptyDetail(context, "announcement", announcement.id),
    date: dayOf(announcement.publishedAt),
    title: announcement.title,
    text: announcement.text,
    sourceUpdatedAt: momentOf(announcement.publishedAt),
  };
}

export function tripDetail(
  context: DetailContext,
  trip: TripItem,
): NewItemDetail {
  return {
    ...emptyDetail(context, "trip", trip.id),
    date: orNull(trip.from),
    title: trip.destination,
    text: [
      `${trip.from} - ${trip.to}`,
      trip.destination,
      trip.route,
      trip.transport,
      trip.coordinator,
    ].join("\n"),
    sender: orNull(trip.coordinator),
  };
}

export function terminarzDetail(
  context: DetailContext,
  entry: HomeworkItem,
): NewItemDetail {
  return {
    ...emptyDetail(context, "terminarz", entry.id),
    date: orNull(entry.date),
    title: entry.subject || entry.category,
    text: entry.content,
    sender: orNull(entry.teacher),
    subject: orNull(entry.subject),
    category: orNull(entry.category),
  };
}

export function meetingDetail(
  context: DetailContext,
  meeting: MeetingItem,
): NewItemDetail {
  return {
    ...emptyDetail(context, "meeting", meeting.id),
    date: orNull(meeting.date),
    startTime: orNull(meeting.start),
    endTime: orNull(meeting.end),
    title: meeting.topic,
    text: [meeting.topic, meeting.room, meeting.teacher]
      .filter((part) => part !== "")
      .join("\n"),
    sender: orNull(meeting.teacher),
  };
}

export function dayOffDetail(
  context: DetailContext,
  dayOff: DayOffItem,
): NewItemDetail {
  return {
    ...emptyDetail(context, "dayOff", dayOff.id),
    date: orNull(dayOff.from),
    title: dayOff.name,
    text: [dayOff.name, `${dayOff.from} - ${dayOff.to}`]
      .filter((part) => part !== "")
      .join("\n"),
  };
}

export function gradeDetail(
  context: DetailContext,
  grade: GradeItem,
): NewItemDetail {
  return {
    ...emptyDetail(context, "grade", grade.id),
    date: orNull(grade.date),
    title: grade.subject,
    text: grade.grade,
    sender: orNull(grade.teacher),
    subject: orNull(grade.subject),
    category: orNull(grade.category),
  };
}

type DetailBuilder = (
  context: DetailContext,
  item: never,
  body: string,
) => NewItemDetail | undefined;

const DETAIL_BUILDERS: Partial<Record<WatcherName, DetailBuilder>> = {
  grades: gradeDetail,
  messages: messageDetail,
  announcements: announcementDetail,
  trips: tripDetail,
  homework: terminarzDetail,
  meetings: meetingDetail,
  schoolFreeDays: dayOffDetail,
  classFreeDays: dayOffDetail,
};

export function detailOf(
  watcher: WatcherName,
  context: DetailContext,
  item: ItemsByWatcher[WatcherName][number],
  body = "",
): NewItemDetail | undefined {
  const build = DETAIL_BUILDERS[watcher] as
    | ((
        context: DetailContext,
        item: ItemsByWatcher[WatcherName][number],
        body: string,
      ) => NewItemDetail | undefined)
    | undefined;
  return build?.(context, item, body);
}
