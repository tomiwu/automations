import { localDate, localTime, t, type Child, type Language, type Recipient } from "@automations/shared";
import type { StorageAdapter } from "@automations/librus-data";
import { timeRange, toItem, type Session, type SessionItem } from "./sessions.ts";
import type { SessionSource } from "./targets.ts";

export const BASELINE_ID = "__baseline__";

const HASH_SEPARATOR = "@";

const DAY_MS = 86_400_000;

export interface WatcherCheck {
  familyId: string;
  child: Child;
  recipients: readonly Recipient[];
  scope: string;
  storage: StorageAdapter;
  source: SessionSource;
  now: Date;
  timezone: string;
}

const storedId = ({ id, hash }: SessionItem): string => `${id}${HASH_SEPARATOR}${hash}`;

const localMinute = (date: Date, timezone: string): string => `${localDate(date, timezone)}T${localTime(date, timezone)}`;

export function startsWithin24Hours(start: string, now: Date, timezone: string): boolean {
  const later = new Date(now.getTime() + DAY_MS);
  return start >= localMinute(now, timezone) && start <= localMinute(later, timezone);
}

export function formatSessionNotification(language: Language, session: Session, urgent: boolean): string {
  const place = session.place ? `, ${session.place}` : "";
  const what = `${session.activity}, ${session.start.slice(0, 10)} ${timeRange(session)}${place}`;
  const key = session.status === "cancelled" ? "session.cancelled" : "session.moved";
  const text = t(language, key, { child: session.child, what });
  return urgent ? t(language, "session.urgent", { text }) : text;
}

export function announcements(current: SessionItem[], known: Set<string>): SessionItem[] {
  const bases = new Set([...known].map((id) => id.split(HASH_SEPARATOR)[0]));
  return current.filter(
    (item) => !known.has(storedId(item)) && bases.has(item.id) && item.session.status !== "planned",
  );
}

async function enqueueFor(check: WatcherCheck, item: SessionItem): Promise<void> {
  const urgent = startsWithin24Hours(item.session.start, check.now, check.timezone);
  for (const recipient of check.recipients) {
    await check.storage.enqueueNotification({
      key: `${check.scope}:${storedId(item)}:${recipient.telegram_chat_id}`,
      familyId: check.familyId,
      chatId: recipient.telegram_chat_id,
      text: formatSessionNotification(recipient.language, item.session, urgent),
    });
  }
}

export async function runWatcher(check: WatcherCheck): Promise<Session[]> {
  const sessions = await check.source.sessions();
  const current = sessions.map(toItem);
  const known = await check.storage.knownItemIds(check.familyId, check.scope);
  if (known.size > 0) {
    for (const item of announcements(current, known)) await enqueueFor(check, item);
  }
  await check.storage.recordItems(check.familyId, check.scope, [BASELINE_ID, ...current.map(storedId)]);
  return sessions;
}
