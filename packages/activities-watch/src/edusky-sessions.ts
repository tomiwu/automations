import type { Activity, Child } from "@automations/shared";
import { makeSession, type Session, type SessionStatus } from "./sessions.ts";

export interface EduskyItem {
  start: string;
  end: string;
  courseGroup: string;
  titleRoom: string;
  cancel: number | boolean | string;
  idActivityShifted: number | null;
  dateBeforeShifted: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}/;

export function statusOf(item: EduskyItem): SessionStatus {
  if (Number(item.cancel)) return "cancelled";
  return item.idActivityShifted || item.dateBeforeShifted ? "moved" : "planned";
}

export function inGroup(item: EduskyItem, group: string | null): boolean {
  return !group || item.courseGroup.includes(group);
}

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
