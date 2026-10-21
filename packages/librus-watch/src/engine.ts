import type { Child, Language, Recipient } from "@automations/shared";
import type { StorageAdapter } from "@automations/librus-data";
import {
  formatAbsence,
  formatAnnouncement,
  formatGrade,
  formatHomework,
  formatLesson,
  formatMessage,
  formatSubstitutions,
  formatTrip,
  type FormatContext,
  type ItemChange,
} from "./format.ts";
import type { ItemsByWatcher, LibrusSource, SubstitutionItem, WatcherName } from "./types.ts";

/** The first record of each Watcher scope. It marks the scope as baselined, even when Librus gave no Item. */
export const BASELINE_ID = "__baseline__";

/** Separates the base ID from the content hash in a recorded ID. Librus IDs never contain it. */
const HASH_SEPARATOR = "@";

/** The Watchers in the order of a Check. */
export const WATCHERS_IN_ORDER: readonly WatcherName[] = [
  "grades",
  "messages",
  "announcements",
  "trips",
  "homework",
  "absences",
  "substitutions",
  "lessons",
];

interface HashedItem {
  id: string;
  hash?: string;
}

interface Changed<I> {
  item: I;
  change: ItemChange;
}

/** One Notification for all Recipients. `text` renders it in the language of one Recipient. */
interface Announcement {
  key: string;
  text: (context: FormatContext) => string;
}

type Announce<I> = (changes: Changed<I>[], source: LibrusSource) => Promise<Announcement[]>;

/** What a Check of one Child needs. */
export interface ChildCheck {
  familyId: string;
  child: Child;
  /** The Recipients that get Notifications for this Child. */
  recipients: readonly Recipient[];
  storage: StorageAdapter;
  source: LibrusSource;
  /** Receives one line for each Watcher. It never gets Item contents. */
  log?: (message: string) => void;
}

const storedId = ({ id, hash }: HashedItem): string => (hash === undefined ? id : `${id}${HASH_SEPARATOR}${hash}`);

/** Returns the scope of the Items of one Child at one Watcher. */
export const scopeOf = (watcher: WatcherName, child: Child): string => `${watcher}:${child.id}`;

function changeOf(item: HashedItem, known: Set<string>, bases: Set<string>): ItemChange | undefined {
  if (known.has(storedId(item))) return undefined;
  return bases.has(item.id) ? "updated" : "new";
}

function changesOf<I extends HashedItem>(current: I[], known: Set<string>): Changed<I>[] {
  const bases = new Set([...known].map((id) => id.split(HASH_SEPARATOR)[0] ?? id));
  return current.flatMap((item) => {
    const change = changeOf(item, known, bases);
    return change === undefined ? [] : [{ item, change }];
  });
}

/** Announces each change on its own. The key is the recorded ID. */
const perItem =
  <I extends HashedItem>(render: (item: I, change: ItemChange, source: LibrusSource) => Promise<Announcement["text"]>): Announce<I> =>
  async (changes, source) => {
    const announcements: Announcement[] = [];
    for (const { item, change } of changes) {
      announcements.push({ key: storedId(item), text: await render(item, change, source) });
    }
    return announcements;
  };

const sync =
  <I>(render: (context: FormatContext, item: I, change: ItemChange) => string) =>
  async (item: I, change: ItemChange): Promise<Announcement["text"]> =>
  (context) =>
    render(context, item, change);

/** All new substitutions of one date become one Notification. The key has the date and the Item IDs. */
const substitutionsPerDay: Announce<SubstitutionItem> = async (changes) => {
  const days = new Map<string, SubstitutionItem[]>();
  for (const { item } of changes) days.set(item.date, [...(days.get(item.date) ?? []), item]);
  return [...days]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({
      key: `${date}:${items.map((item) => item.id).join(",")}`,
      text: (context) => formatSubstitutions(context, date, items),
    }));
};

/** Only an updated Lesson that is now cancelled or substituted is news. */
const lessonChanges = (changes: Changed<ItemsByWatcher["lessons"][number]>[]) =>
  changes.filter(({ item, change }) => change === "updated" && item.status !== "normal");

type AnyAnnounce = Announce<never>;
const asAny = <I>(announce: Announce<I>): AnyAnnounce => announce as unknown as AnyAnnounce;

const ANNOUNCERS: Record<WatcherName, AnyAnnounce> = {
  grades: asAny(perItem(sync(formatGrade))),
  // Opening a message marks it read in Librus. Only a new message is opened.
  messages: asAny(
    perItem<ItemsByWatcher["messages"][number]>(async (message, _change, source) => {
      const body = await source.messageBody(message.id);
      return (context) => formatMessage(context, message, body);
    }),
  ),
  announcements: asAny(perItem(sync(formatAnnouncement))),
  trips: asAny(perItem(sync(formatTrip))),
  homework: asAny(perItem(sync(formatHomework))),
  absences: asAny(perItem(sync(formatAbsence))),
  substitutions: asAny(substitutionsPerDay),
  lessons: asAny((changes, source) =>
    perItem(sync(formatLesson))(lessonChanges(changes as never) as never, source),
  ),
};

/** Queues the Notification for each Recipient. The key has the chat ID, so each queue is idempotent. */
async function enqueueFor(check: ChildCheck, scope: string, announcement: Announcement): Promise<void> {
  for (const recipient of check.recipients) {
    const context: FormatContext = { language: recipient.language as Language, child: check.child.name };
    await check.storage.enqueueNotification({
      key: `${scope}:${announcement.key}:${recipient.telegram_chat_id}`,
      familyId: check.familyId,
      chatId: recipient.telegram_chat_id,
      text: announcement.text(context),
    });
  }
}

/**
 * Runs one Watcher for one Child. The first run of a scope is a silent Baseline: it records the Items and
 * queues nothing. Later runs queue one Notification for each new or updated Item and each Recipient, then
 * record the Items. The Notification is queued first and its key is the recorded ID, so a crash between
 * the two steps neither loses nor repeats it.
 */
export async function runWatcher(check: ChildCheck, watcher: WatcherName): Promise<void> {
  const scope = scopeOf(watcher, check.child);
  const current = (await check.source.currentItems(watcher)) as HashedItem[];
  const known = await check.storage.knownItemIds(check.familyId, scope);
  if (known.size > 0) {
    const changes = changesOf(current, known);
    for (const announcement of await (ANNOUNCERS[watcher] as Announce<HashedItem>)(changes, check.source)) {
      await enqueueFor(check, scope, announcement);
    }
  }
  await check.storage.recordItems(check.familyId, scope, [BASELINE_ID, ...current.map(storedId)]);
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Runs each Watcher of one Child. A Watcher that fails does not stop the others.
 * Returns one failure text for each failed Watcher.
 */
export async function runChildCheck(check: ChildCheck, watchers: readonly WatcherName[] = WATCHERS_IN_ORDER): Promise<string[]> {
  const failures: string[] = [];
  for (const watcher of watchers) {
    try {
      await runWatcher(check, watcher);
      check.log?.(`watcher ${watcher}: ok`);
    } catch (error) {
      check.log?.(`watcher ${watcher}: fail`);
      failures.push(`${watcher}: ${messageOf(error)}`);
    }
  }
  return failures;
}
