import type { ItemKind, NewItemDetail } from "@automations/librus-data";
import type {
  AnnouncementItem,
  DayOffItem,
  HomeworkItem,
  MeetingItem,
  ItemsByWatcher,
  MessageItem,
  TripItem,
  WatcherName,
} from "./types.ts";

/** Where a detail belongs: the Family, the scope of the Watcher and the Child. */
export interface DetailContext {
  familyId: string;
  scope: string;
  childId: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/;

/** The day of a Librus date text such as "2026-01-05 10:30:00", or null. */
const dayOf = (value: string): string | null =>
  value.match(DATE_PATTERN)?.[0] ?? null;

/** The moment of a Librus date text (read as UTC), or null when it is not a date and time. */
function momentOf(value: string): Date | null {
  if (!DATE_PATTERN.test(value)) return null;
  const moment = new Date(
    `${value.slice(0, 10)}T${value.slice(11, 19) || "00:00:00"}Z`,
  );
  return Number.isNaN(moment.getTime()) ? null : moment;
}

/** The text, or null when it is empty. */
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

/** The content of a message: sender, subject, send time and the whole body. */
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

/** The content of an announcement: the title, the whole text and the publication time. */
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

/** The content of a trip. The date is the first day. The text has the date range, the route, the transport and the coordinator. */
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

/** The content of a Terminarz entry: date, category, subject, teacher and the whole content. */
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

/** The content of a meeting: date, times, topic, room and teacher. */
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

/** The content of a day off. The date is the first day. The text has the name and the date range. */
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

type DetailBuilder = (
  context: DetailContext,
  item: never,
  body: string,
) => NewItemDetail | undefined;

const DETAIL_BUILDERS: Partial<Record<WatcherName, DetailBuilder>> = {
  messages: messageDetail,
  announcements: announcementDetail,
  trips: tripDetail,
  homework: terminarzDetail,
  meetings: meetingDetail,
  schoolFreeDays: dayOffDetail,
  classFreeDays: dayOffDetail,
};

/**
 * The content of one Item of a Watcher. A message needs its `body`. Returns undefined when the
 * Watcher has no stored content.
 */
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
