import { t, type Language, type MessageKey } from "@automations/shared";
import { timeRange, type Session, type SessionStatus } from "./sessions.ts";

export interface MailFact {
  childId: string;
  activity: string;
  /** Local start, "YYYY-MM-DDTHH:MM". The day pairs the fact with a Session. */
  start: string;
  /** Fields that the mail does not state stay undefined and are not compared. */
  end?: string;
  place?: string;
  status?: SessionStatus;
}

type Field = "status" | "start" | "end" | "place";

/** One Session that disagrees with the mail. `key` is stable, so a retry does not queue a second Notification. */
export interface MailDifference {
  session: Session;
  fields: Field[];
  key: string;
  text(language: Language): string;
}

export interface MailComparison {
  /** All input Sessions. The app values stay. A Session that disagrees gets `warning`. */
  sessions: Session[];
  /** One for each Session that disagrees. The caller queues one Notification for each. */
  differences: MailDifference[];
}

const FIELDS: Field[] = ["status", "start", "end", "place"];

const norm = (value: string): string => value.trim().toLowerCase();

const sameDay = (a: string, b: string): boolean => a.slice(0, 10) === b.slice(0, 10);

const matches = (session: Session, fact: MailFact): boolean =>
  session.childId === fact.childId && session.activity === fact.activity && sameDay(session.start, fact.start);

function differingFields(session: Session, fact: MailFact): Field[] {
  return FIELDS.filter((field) => {
    const mail = fact[field];
    return mail !== undefined && norm(mail) !== norm(session[field]);
  });
}

function valueText(language: Language, field: Field, value: string): string {
  if (value === "") return t(language, "mail.none");
  return field === "status" ? t(language, `session.status.${value}` as MessageKey) : value;
}

function describe(language: Language, session: Session, fact: MailFact, fields: Field[]): string {
  const what = `${session.activity}, ${session.start.slice(0, 10)} ${timeRange(session)}`;
  const parts = fields.map((field) =>
    t(language, "mail.part", {
      field: t(language, `mail.field.${field}` as MessageKey),
      app: valueText(language, field, session[field]),
      mail: valueText(language, field, fact[field] ?? ""),
    }),
  );
  return t(language, "mail.differs", { child: session.child, what, parts: parts.join("; ") });
}

function difference(session: Session, facts: MailFact[]): MailDifference | undefined {
  for (const fact of facts.filter((candidate) => matches(session, candidate))) {
    const fields = differingFields(session, fact);
    if (fields.length > 0) {
      const key = `mail-differs:${session.id}:${fields.map((field) => `${field}=${fact[field]}`).join("|")}`;
      return { session, fields, key, text: (language) => describe(language, session, fact, fields) };
    }
  }
  return undefined;
}

/**
 * Compares Sessions from the app with facts from mails. The app wins: no Session value changes.
 * A Session that disagrees with a fact gets `warning: "mail differs"` and one MailDifference. A fact
 * with no Session is ignored. If many facts disagree with one Session, the first one is reported.
 */
export function compareWithMail(sessions: Session[], facts: MailFact[]): MailComparison {
  const differences = sessions.flatMap((session) => difference(session, facts) ?? []);
  const warned = new Set(differences.map((entry) => entry.session));
  return {
    sessions: sessions.map((session) => (warned.has(session) ? { ...session, warning: "mail differs" as const } : session)),
    differences,
  };
}
