/**
 * The pure create/update plan of the calendar sync (kids calendar contract sections 3, 4, 8a and 8b).
 * It reads the state of the stored exports and the Google events of the window and returns the events to
 * create and to update. It never returns a delete (W5). It uses no network and no clock.
 */

export type HomeworkMark = "Zadanie" | "Kartkówka" | "Sprawdzian";

interface CalendarEntry {
  /** The Google calendar of the Child. Two Children never share a key, because the key has the calendar. */
  calendarId: string;
  /** The title prefix of the Child, for example `Child One`. */
  prefix: string;
  /** The stream head says that the item vanished from the source. The event stays and gets `[usunięte?]`. */
  vanished?: boolean;
}

/** One Lesson of `./stored-lessons`, with the homework marks of its slot. */
export interface PlanLesson extends CalendarEntry {
  date: string;
  period: number;
  /** `HH:MM` in the Family time zone. */
  start: string;
  end: string;
  subject: string;
  status: "normal" | "cancelled" | "substitution";
  cancelReason?: { reason: string } | null;
  substituteTeacher?: string;
  homework?: readonly HomeworkMark[];
}

/** One activity session of `./stored-sessions`. */
export interface PlanSession extends CalendarEntry {
  service: string;
  date: string;
  start: string;
  end: string;
  activity: string;
  status: "planned" | "cancelled";
  place?: string;
  teacher?: string;
  note?: string;
}

export interface CalendarState {
  lessons: readonly PlanLesson[];
  sessions: readonly PlanSession[];
}

/** The fields of a calendar event that the plan writes. `start` and `end` are local `YYYY-MM-DDTHH:MM`. */
export interface PlannedEvent {
  calendarId: string;
  summary: string;
  description: string;
  start: string;
  end: string;
  location: string;
}

/** A Google event of the window. An event without a key marker belongs to the owner and is never touched (W6). */
export interface ExistingEvent extends PlannedEvent {
  id: string;
}

export interface CalendarPlan {
  creates: PlannedEvent[];
  updates: ExistingEvent[];
}

export const CANCELLED_LESSON = "[ODWOŁANA]";
export const DAY_OFF_LESSON = "[ODWOŁANA] (dzień wolny)";
export const CANCELLED_SESSION = "[ODWOŁANE]";
export const VANISHED = "[usunięte?]";

const HOMEWORK_SUFFIX: Record<HomeworkMark, string> = { Zadanie: " 📚 Zadanie", Kartkówka: " ❗ Kartkówka", Sprawdzian: " ❗ Sprawdzian" };

const MARKER = /^\[(librus-lesson|librus-msg|activity): [^\]]+\]$/;

/** The key marker on the last line of a description, or null for an event of the owner. */
export function markerOf(description: string): string | null {
  const last = description.trimEnd().split("\n").pop() ?? "";
  return MARKER.test(last) ? last : null;
}

const withToken = (summary: string, token: string | null): string => (token === null ? summary : `${summary} ${token}`);

function lessonToken(lesson: PlanLesson): string | null {
  if (lesson.status !== "cancelled") return null;
  return lesson.cancelReason?.reason === "day_off" ? DAY_OFF_LESSON : CANCELLED_LESSON;
}

const vanishedToken = (entry: CalendarEntry, token: string | null): string | null => (entry.vanished ? VANISHED : token);

const lines = (...parts: (string | undefined)[]): string => parts.filter((part): part is string => part !== undefined).join("\n");

function lessonEvent(lesson: PlanLesson): PlannedEvent {
  const homework = (lesson.homework ?? []).map((mark) => HOMEWORK_SUFFIX[mark]).join("");
  const substitute = lesson.status === "substitution" && lesson.substituteTeacher ? `Zastępstwo: ${lesson.substituteTeacher}` : undefined;
  return {
    calendarId: lesson.calendarId,
    summary: withToken(`${lesson.prefix}: ${lesson.period}. ${lesson.subject}${homework}`, vanishedToken(lesson, lessonToken(lesson))),
    description: lines(substitute, `[librus-lesson: ${lesson.date}-${lesson.period}]`),
    start: `${lesson.date}T${lesson.start}`,
    end: `${lesson.date}T${lesson.end}`,
    location: "",
  };
}

const labelled = (label: string, value: string | undefined): string | undefined => (value ? `${label}: ${value}` : undefined);

/** `Miejsce:`, `Prowadzący:` and `Uwaga:` when known, then the marker (contract section 3). No `Serwis:` line. */
function sessionDescription(session: PlanSession): string {
  return lines(
    labelled("Miejsce", session.place),
    labelled("Prowadzący", session.teacher),
    labelled("Uwaga", session.note),
    `[activity: ${session.service}-${session.date}-${session.start}]`,
  );
}

function sessionEvent(session: PlanSession): PlannedEvent {
  const token = session.status === "cancelled" ? CANCELLED_SESSION : null;
  return {
    calendarId: session.calendarId,
    summary: withToken(`${session.prefix}: ${session.activity}`, vanishedToken(session, token)),
    description: sessionDescription(session),
    start: `${session.date}T${session.start}`,
    end: `${session.date}T${session.end}`,
    location: session.place ?? "",
  };
}

const keyOf = (event: PlannedEvent): string | null => {
  const marker = markerOf(event.description);
  return marker === null ? null : `${event.calendarId}\u0000${marker}`;
};

const FIELDS = ["summary", "description", "start", "end", "location"] as const;
const sameEvent = (a: PlannedEvent, b: PlannedEvent): boolean => FIELDS.every((field) => a[field] === b[field]);

/** The events that the state wants: one for each Lesson and session. */
export function desiredEvents(state: CalendarState): PlannedEvent[] {
  return [...state.lessons.map(lessonEvent), ...state.sessions.map(sessionEvent)];
}

/**
 * The plan: a create for each wanted event with no existing event of the same key (calendar and marker),
 * and an update for each existing event that differs. An existing event that the state does not name is
 * left as it is: the plan never deletes (W5) and never touches an event of the owner (W6).
 */
export function planCalendar(state: CalendarState, existing: readonly ExistingEvent[]): CalendarPlan {
  const byKey = new Map(existing.flatMap((event) => {
    const key = keyOf(event);
    return key === null ? [] : [[key, event] as const];
  }));
  const plan: CalendarPlan = { creates: [], updates: [] };
  for (const wanted of desiredEvents(state)) {
    const key = keyOf(wanted) ?? "";
    const found = byKey.get(key);
    if (found === undefined) {
      plan.creates.push(wanted);
      byKey.set(key, { ...wanted, id: "" });
    } else if (!sameEvent(found, wanted)) plan.updates.push({ ...wanted, id: found.id });
  }
  return plan;
}
