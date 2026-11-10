import type { Child, Language, Recipient } from "@automations/shared";
import type { NewItemDetail, NewNotification, StorageAdapter } from "@automations/librus-data";
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
import { detailOf } from "./details.ts";
import type { HomeworkItem, ItemsByWatcher, LibrusSource, SubstitutionItem, WatcherName } from "./types.ts";

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
  "meetings",
  "schoolFreeDays",
  "classFreeDays",
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
  /** The ID of the Item, and the message body when the announcer read it. */
  itemId?: string;
  body?: string;
}

/** The text renderer of one Item. A message also gives its body, so the engine can store it. */
interface Rendered {
  text: Announcement["text"];
  body?: string;
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
  <I extends HashedItem>(render: (item: I, change: ItemChange, source: LibrusSource) => Promise<Rendered>): Announce<I> =>
  async (changes, source) => {
    const announcements: Announcement[] = [];
    for (const { item, change } of changes) {
      const { text, body } = await render(item, change, source);
      announcements.push({ key: storedId(item), text, itemId: item.id, body });
    }
    return announcements;
  };

const sync =
  <I,>(render: (context: FormatContext, item: I, change: ItemChange) => string) =>
  async (item: I, change: ItemChange): Promise<Rendered> => ({
    text: (context) => render(context, item, change),
  });

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
const asAny = <I,>(announce: Announce<I>): AnyAnnounce => announce as unknown as AnyAnnounce;

/** Stored, never announced: the morning report shows these Items. */
const silent: AnyAnnounce = async () => [];

const ANNOUNCERS: Record<WatcherName, AnyAnnounce> = {
  grades: asAny(perItem(sync(formatGrade))),
  // Opening a message marks it read in Librus. Only a new message is opened.
  messages: asAny(
    perItem<ItemsByWatcher["messages"][number]>(async (message, _change, source) => {
      const body = await source.messageBody(message.id);
      return { text: (context) => formatMessage(context, message, body), body };
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
  meetings: silent,
  schoolFreeDays: silent,
  classFreeDays: silent,
};

/** Makes the Notification for each Recipient. The key has the chat ID, so each queue is idempotent. */
function notificationsFor(check: ChildCheck, scope: string, announcement: Announcement): NewNotification[] {
  return check.recipients.map((recipient) => {
    const context: FormatContext = { language: recipient.language as Language, child: check.child.name };
    return {
      key: `${scope}:${announcement.key}:${recipient.telegram_chat_id}`,
      familyId: check.familyId,
      chatId: recipient.telegram_chat_id,
      text: announcement.text(context),
    };
  });
}

/** The content rows of the changed Items. A message row needs the body that its announcer read. */
function detailsOf(
  check: ChildCheck,
  watcher: WatcherName,
  scope: string,
  changes: Changed<HashedItem>[],
  announcements: Announcement[],
): NewItemDetail[] {
  const bodies = new Map(announcements.map((a) => [a.itemId, a.body]));
  const context = { familyId: check.familyId, scope, childId: check.child.id };
  return changes.flatMap(({ item }) => {
    const detail = detailOf(watcher, context, item as never, bodies.get(item.id));
    return detail === undefined ? [] : [detail];
  });
}

/**
 * The Watchers whose Items cancel Lessons (days off). Their content is stored on each run, also on the
 * Baseline, so a day off that was in Librus before the first run still cancels its Lessons. The storage
 * skips content that did not change, so a run with the same days off adds no Journal event.
 */
const ALWAYS_STORED: readonly WatcherName[] = ["schoolFreeDays", "classFreeDays"];

/**
 * Runs one Watcher for one Child. The first run of a scope is a silent Baseline: it records the Items,
 * queues nothing and stores no content. Later runs store the content of each new or updated Item, queue
 * one Notification for each Item and each Recipient, then record the Items. The Notification is queued
 * first and its key is the recorded ID, so a crash between the two steps neither loses nor repeats it.
 * The days-off Watchers (`ALWAYS_STORED`) store their content on every run.
 */
export async function runWatcher(check: ChildCheck, watcher: WatcherName): Promise<HashedItem[]> {
  const scope = scopeOf(watcher, check.child);
  const current = (await check.source.currentItems(watcher)) as HashedItem[];
  const known = await check.storage.knownItemIds(check.familyId, scope);
  if (ALWAYS_STORED.includes(watcher)) {
    await check.storage.recordDetails(detailsOf(check, watcher, scope, current.map((item) => ({ item, change: "new" })), []));
  }
  if (known.size > 0) {
    const changes = changesOf(current, known);
    const announcements = await (ANNOUNCERS[watcher] as Announce<HashedItem>)(changes, check.source);
    await check.storage.recordDetails(detailsOf(check, watcher, scope, changes, announcements));
    await check.storage.enqueueNotifications(announcements.flatMap((a) => notificationsFor(check, scope, a)));
  }
  await check.storage.recordItems(check.familyId, scope, [BASELINE_ID, ...current.map(storedId)]);
  return current;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The failure texts of a Check, and the homework Items when the `homework` Watcher ran without a failure. */
export interface ChildCheckResult {
  failures: string[];
  homework?: HomeworkItem[];
}

/**
 * Runs each Watcher of one Child. A Watcher that fails does not stop the others.
 * Returns one failure text for each failed Watcher, and the homework Items that the run read.
 */
export async function checkChild(check: ChildCheck, watchers: readonly WatcherName[] = WATCHERS_IN_ORDER): Promise<ChildCheckResult> {
  const result: ChildCheckResult = { failures: [] };
  for (const watcher of watchers) {
    try {
      const items = await runWatcher(check, watcher);
      if (watcher === "homework") result.homework = items as HomeworkItem[];
      check.log?.(`watcher ${watcher}: ok`);
    } catch (error) {
      check.log?.(`watcher ${watcher}: fail`);
      result.failures.push(`${watcher}: ${messageOf(error)}`);
    }
  }
  return result;
}

/** Like `checkChild`, but returns only the failure texts. */
export async function runChildCheck(check: ChildCheck, watchers: readonly WatcherName[] = WATCHERS_IN_ORDER): Promise<string[]> {
  return (await checkChild(check, watchers)).failures;
}
