import { addDays, type Activity, type Child, type Service } from "@automations/shared";

export type SessionStatus = "planned" | "cancelled" | "moved";

/** One class on one day, as the app of an organizer shows it. */
export interface Session {
  childId: string;
  /** The name of the Child. */
  child: string;
  /** The name of the Activity in the config, not the group name that the app shows. */
  activity: string;
  service: Service;
  /** Local start and end, "YYYY-MM-DDTHH:MM", no offset. */
  start: string;
  end: string;
  place: string;
  status: SessionStatus;
  /** The app is the only source. The mail comparison adds a warning, not a source. */
  source: "app";
  /** Set by the mail comparison when a mail of the organizer does not agree with the app. */
  warning?: "mail differs";
  /** Stable across moves: the Activity, and the day and time that the class had before it moved. */
  id: string;
}

/** A Session as the Item store sees it. The hash changes when the status, the time or the place changes. */
export interface SessionItem {
  id: string;
  hash: string;
  session: Session;
}

/** Days ahead that a run reads, today included. */
export const WINDOW_DAYS = 14;

export function toItem(session: Session): SessionItem {
  const { status, start, end, place } = session;
  return { id: session.id, hash: [status, start, end, place].join("|"), session };
}

/** Returns true when the Session starts from `today` up to the end of the window. */
export function inWindow(session: Session, today: string): boolean {
  const day = session.start.slice(0, 10);
  return day >= today && day < addDays(today, WINDOW_DAYS);
}

/** Returns the readable time range of a Session, for example "15:00-16:00". */
export function timeRange(session: Pick<Session, "start" | "end">): string {
  return `${session.start.slice(11)}-${session.end.slice(11)}`;
}

export interface SessionFields {
  start: string;
  end: string;
  place: string;
  status: SessionStatus;
  /** The day and the time that the class had before any move. They make the ID. */
  idDay: string;
  idTime: string;
}

/** Makes the Session of one class. The Activity gives the name and the place when the app gives none. */
export function makeSession(
  child: Pick<Child, "id" | "name">,
  activity: Pick<Activity, "id" | "name" | "place">,
  service: Service,
  fields: SessionFields,
): Session {
  return {
    childId: child.id,
    child: child.name,
    activity: activity.name,
    service,
    start: fields.start,
    end: fields.end,
    place: fields.place || activity.place || "",
    status: fields.status,
    source: "app",
    id: `${activity.id}:${fields.idDay}:${fields.idTime}`,
  };
}
