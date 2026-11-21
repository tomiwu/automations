import { localDate, localTime, t, type Child, type Language, type Recipient } from "@automations/shared";
import type { StorageAdapter } from "@automations/librus-data";
import { timeRange, toItem, type Session, type SessionItem } from "./sessions.ts";
import type { SessionSource } from "./targets.ts";

/** The first record of each scope. It marks the scope as baselined, even when the app gave no Session. */
export const BASELINE_ID = "__baseline__";

/** Separates the base ID from the content hash in a recorded ID. Session IDs never contain it. */
const HASH_SEPARATOR = "@";

const DAY_MS = 86_400_000;

/** What a Check of one Account needs. */
export interface WatcherCheck {
  familyId: string;
  child: Child;
  /** The Recipients that get Notifications for this Child. */
  recipients: readonly Recipient[];
  /** The scope of the Items of this Account, for example `edusky:<account id>`. */
  scope: string;
  storage: StorageAdapter;
  source: SessionSource;
  now: Date;
  timezone: string;
}

const storedId = ({ id, hash }: SessionItem): string => `${id}${HASH_SEPARATOR}${hash}`;

const localMinute = (date: Date, timezone: string): string => `${localDate(date, timezone)}T${localTime(date, timezone)}`;

/** Returns true when the local `start` ("YYYY-MM-DDTHH:MM") is from `now` up to 24 hours after `now`. */
export function startsWithin24Hours(start: string, now: Date, timezone: string): boolean {
  const later = new Date(now.getTime() + DAY_MS);
  return start >= localMinute(now, timezone) && start <= localMinute(later, timezone);
}

/** Renders the Notification for a Session that is now cancelled or moved. An urgent one starts with a marker. */
export function formatSessionNotification(language: Language, session: Session, urgent: boolean): string {
  const place = session.place ? `, ${session.place}` : "";
  const what = `${session.activity}, ${session.start.slice(0, 10)} ${timeRange(session)}${place}`;
  const key = session.status === "cancelled" ? "session.cancelled" : "session.moved";
  const text = t(language, key, { child: session.child, what });
  return urgent ? t(language, "session.urgent", { text }) : text;
}

/**
 * Only an updated Item that is now cancelled or moved is news. A Session that enters the 14-day
 * window, or goes back to planned, is recorded silently.
 */
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

/**
 * Runs the Watcher of one Account. The first run of a scope is a silent Baseline: it records the Items
 * and queues nothing. Later runs queue one Notification for each cancelled or moved Session and each
 * Recipient, then record the Items. The Notification is queued first and its key is the recorded ID,
 * so a crash between the two steps neither loses nor repeats it. Returns the Sessions that the run read.
 */
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
