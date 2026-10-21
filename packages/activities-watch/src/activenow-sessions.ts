import type { Activity, Child } from "@automations/shared";
import type { ActiveNowEvent } from "./activenow-parse.ts";
import { makeSession, type Session, type SessionStatus } from "./sessions.ts";

const CANCELLED_BADGE = /odwołan|anulowan/i;
const ABSENCE_BADGE = /nieobecno/i;
const MOVED_BADGE = /zmieniony termin/i;

/**
 * A cancel chip, or a struck-out date without an absence chip (the app also strikes out a class
 * that a parent reported absent). UNVERIFIED against a real cancellation.
 */
function isCancelled({ badges, struckOut }: ActiveNowEvent): boolean {
  return badges.some((b) => CANCELLED_BADGE.test(b)) || (struckOut && !badges.some((b) => ABSENCE_BADGE.test(b)));
}

/** Returns the status of a class. `moved` is a changed time: the card shows the day it had before, or the chip. */
export function statusOf(event: ActiveNowEvent): SessionStatus {
  if (isCancelled(event)) return "cancelled";
  return event.originalDate || event.badges.some((b) => MOVED_BADGE.test(b)) ? "moved" : "planned";
}

/** Makes the Session of one card. Its ID uses the day before a move, so a move updates the Item. */
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
