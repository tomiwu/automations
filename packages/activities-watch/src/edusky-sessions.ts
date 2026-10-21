import type { Activity, Child } from "@automations/shared";
import { makeSession, type Session, type SessionStatus } from "./sessions.ts";

/** The fields of one calendar item (`ext/calendaritemslist`) that the Watcher reads. */
export interface EduskyItem {
  /** Local start and end, "YYYY-MM-DDTHH:MM". */
  start: string;
  end: string;
  /** Group name. It tells the Children of a shared login apart. */
  courseGroup: string;
  /** Empty for a class without a room. */
  titleRoom: string;
  /** 1 for a cancelled class. */
  cancel: number | boolean | string;
  /** Set when the class was moved to another day. */
  idActivityShifted: number | null;
  /** The time that the class had before a move, "YYYY-MM-DD HH:MM:SS". Empty when it was not moved. */
  dateBeforeShifted: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}/;

/** UNVERIFIED against a real cancellation or move. The app reads `cancel` and `idActivityShifted` the same way. */
export function statusOf(item: EduskyItem): SessionStatus {
  if (Number(item.cancel)) return "cancelled";
  return item.idActivityShifted || item.dateBeforeShifted ? "moved" : "planned";
}

/** Returns true when the item belongs to the group of the Account. An Account without a group takes every item. */
export function inGroup(item: EduskyItem, group: string | null): boolean {
  return !group || item.courseGroup.includes(group);
}

/** Makes the Session of one item. Its ID uses the day before a move, so a move updates the Item. */
export function toSession(item: EduskyItem, child: Child, activity: Activity): Session {
  const [day = "", time = ""] = item.start.split("T");
  const before = item.dateBeforeShifted.match(DAY)?.[0];
  return makeSession(child, activity, "edusky", {
    start: item.start,
    end: item.end,
    place: item.titleRoom,
    status: statusOf(item),
    idDay: before ?? day,
    idTime: time,
  });
}
