import { t, type Child, type Language } from "@automations/shared";
import { collectSessions, type CollectDeps } from "./collect-sessions.ts";
import { timeRange, type Session } from "./sessions.ts";

/** Returns the text of the after-school section of a Child for a day, in the language of a Recipient. */
export type AfterSchool = (child: Pick<Child, "id" | "name">, day: string, language: Language) => Promise<string>;

function line(language: Language, session: Session): string {
  const params = { time: timeRange(session), name: session.activity, place: session.place };
  const text = t(language, session.place ? "afterschool.item" : "afterschool.item_no_place", params);
  const entry = `• ${text}`;
  if (session.status === "planned") return entry;
  return t(language, session.status === "cancelled" ? "afterschool.cancelled" : "afterschool.moved", { line: entry });
}

/**
 * The after-school section of the Morning report: the Sessions of one Child on `day` ("YYYY-MM-DD"),
 * in time order, with the status. A moved Session shows on the day it moved to. An Account that
 * failed to give its Sessions adds a warning line.
 */
export function formatAfterSchool(language: Language, childId: string, day: string, sessions: Session[], errors: string[] = []): string {
  const today = sessions
    .filter((session) => session.childId === childId && session.start.startsWith(day))
    .sort((a, b) => a.start.localeCompare(b.start));
  const body = today.length === 0 ? [t(language, "afterschool.none")] : today.map((session) => line(language, session));
  const warning = errors.length > 0 ? [t(language, "afterschool.partial")] : [];
  return [`${t(language, "afterschool.title")}:`, ...body, ...warning].join("\n");
}

/** Makes the `afterSchool` port of the Morning report of `librus-watch`. It reads only the Accounts of the Child. */
export function createAfterSchool(deps: CollectDeps): AfterSchool {
  return async (child, day, language) => {
    const { sessions, errors } = await collectSessions(deps, child.id);
    return formatAfterSchool(language, child.id, day, sessions, errors);
  };
}
