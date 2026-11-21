import type { Activity, Child } from "@automations/shared";
import type { ActiveNowEvent } from "./activenow-parse.ts";
import { makeSession, type Session, type SessionStatus } from "./sessions.ts";

const CANCELLED_BADGE = /odwołan|anulowan/i;
const ABSENCE_BADGE = /nieobecno/i;
const MOVED_BADGE = /zmieniony termin/i;

function isCancelled({ badges, struckOut }: ActiveNowEvent): boolean {
  return badges.some((b) => CANCELLED_BADGE.test(b)) || (struckOut && !badges.some((b) => ABSENCE_BADGE.test(b)));
}

export function statusOf(event: ActiveNowEvent): SessionStatus {
  if (isCancelled(event)) return "cancelled";
  return event.originalDate || event.badges.some((b) => MOVED_BADGE.test(b)) ? "moved" : "planned";
}

export function toSession(event: ActiveNowEvent, child: Child, activity: Activity): Session {
  return makeSession(child, activity, "activenow", {
    start: `${event.date}T${event.from}`,
    end: `${event.date}T${event.to}`,
    place: event.place,
    status: statusOf(event),
    idDay: event.originalDate ?? event.date,
    idTime: event.from,
  });
}
