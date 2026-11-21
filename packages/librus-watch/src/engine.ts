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

export const BASELINE_ID = "__baseline__";

const HASH_SEPARATOR = "@";

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

interface Announcement {
  key: string;
  text: (context: FormatContext) => string;
  itemId?: string;
  body?: string;
}

interface Rendered {
  text: Announcement["text"];
  body?: string;
}

type Announce<I> = (changes: Changed<I>[], source: LibrusSource) => Promise<Announcement[]>;

export interface ChildCheck {
  familyId: string;
  child: Child;
  recipients: readonly Recipient[];
  storage: StorageAdapter;
  source: LibrusSource;
  log?: (message: string) => void;
}

const storedId = ({ id, hash }: HashedItem): string => (hash === undefined ? id : `${id}${HASH_SEPARATOR}${hash}`);

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

const lessonChanges = (changes: Changed<ItemsByWatcher["lessons"][number]>[]) =>
  changes.filter(({ item, change }) => change === "updated" && item.status !== "normal");

type AnyAnnounce = Announce<never>;
const asAny = <I,>(announce: Announce<I>): AnyAnnounce => announce as unknown as AnyAnnounce;

const silent: AnyAnnounce = async () => [];

const ANNOUNCERS: Record<WatcherName, AnyAnnounce> = {
  grades: asAny(perItem(sync(formatGrade))),
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

const ALWAYS_STORED: readonly WatcherName[] = ["schoolFreeDays", "classFreeDays"];

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

export interface ChildCheckResult {
  failures: string[];
  homework?: HomeworkItem[];
}

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

export async function runChildCheck(check: ChildCheck, watchers: readonly WatcherName[] = WATCHERS_IN_ORDER): Promise<string[]> {
  return (await checkChild(check, watchers)).failures;
}
