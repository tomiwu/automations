import {
  addDays,
  localDate,
  t,
  weekdayOf,
  zonedParts,
  type Language,
  type MessageKey,
  type Recipient,
} from "@automations/shared";
import type { ItemDetail, NewNotification, StorageAdapter } from "@automations/librus-data";
import { upcoming, type ChildRef, type Upcoming, type UpcomingEntry } from "./upcoming.ts";
import type { LibrusSource } from "./types.ts";

/** UTC hour of the scheduled run (cron `30 4,12 * * *`) that also sends the Morning report, Monday to Friday. */
export const MORNING_REPORT_UTC_HOUR = 4;
/** Days after today that the report lists. */
const WEEK_DAYS = 8;
const CONTENT_LIMIT = 200;
const TITLE_LIMIT = 80;
const DAY_MS = 24 * 60 * 60 * 1000;
/** On Monday the last report ran on Friday, 72 hours before. */
const MONDAY_WINDOW_DAYS = 3;

/** Returns the text of the after-school section of a Child for a day, in the language of a Recipient. */
export type AfterSchool = (child: ChildRef, day: string, language: Language) => Promise<string>;

const dayLabel = (language: Language, date: string): string =>
  `${t(language, `weekday.${weekdayOf(date)}` as MessageKey)} ${date.slice(8, 10)}.${date.slice(5, 7)}`;

function whenText(language: Language, entry: UpcomingEntry): string {
  if (!entry.start) return t(language, "morning.all_day");
  return entry.end ? `${entry.start}-${entry.end}` : entry.start;
}

function contentText(content: string): string {
  if (!content) return "";
  return ` - ${content.length > CONTENT_LIMIT ? `${content.slice(0, CONTENT_LIMIT)}…` : content}`;
}

function entryLine(language: Language, entry: UpcomingEntry): string {
  const category = entry.category || t(language, "morning.default_category");
  const subject = entry.subject || t(language, "morning.no_subject");
  return `• ${whenText(language, entry)} ${category}: ${subject}${contentText(entry.content)}`;
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > TITLE_LIMIT ? `${line.slice(0, TITLE_LIMIT)}…` : line;
}

function newItemLine(language: Language, item: ItemDetail): string {
  const kind = t(language, `item.kind.${item.kind}` as MessageKey);
  const dated = item.date !== null;
  const base = { kind, date: item.date ?? "" };
  if (item.kind === "grade") {
    const values = { ...base, subject: oneLine(item.title), value: oneLine(item.text) };
    return `• ${t(language, dated ? "morning.new_grade" : "morning.new_grade_undated", values)}`;
  }
  return `• ${t(language, dated ? "morning.new_line" : "morning.new_undated", { ...base, title: oneLine(item.title) })}`;
}

function newItemsSection(language: Language, items: readonly ItemDetail[]): string[] {
  if (items.length === 0) return [];
  return [[t(language, "morning.new"), ...items.map((item) => newItemLine(language, item))].join("\n")];
}

function section(language: Language, title: MessageKey, entries: UpcomingEntry[], grouped: boolean): string {
  const head = t(language, title);
  if (entries.length === 0) return `${head}\n${t(language, "morning.nothing")}`;
  if (!grouped) return [head, ...entries.map((entry) => entryLine(language, entry))].join("\n");
  const days = new Map<string, string[]>();
  for (const entry of entries) days.set(entry.date, [...(days.get(entry.date) ?? []), entryLine(language, entry)]);
  return [head, ...[...days].map(([date, lines]) => [`${dayLabel(language, date)}:`, ...lines].join("\n"))].join("\n");
}

function lessonsText(language: Language, today: string, data: Upcoming): string {
  const todays = data.lessons.filter((l) => l.date === today).sort((a, b) => a.period - b.period);
  if (todays.length === 0) {
    return t(language, data.timetableOk ? "morning.no_lessons" : "morning.timetable_failed");
  }
  return todays
    .map((l) => {
      const cancelled = l.status === "cancelled" ? ` ${t(language, "morning.cancelled")}` : "";
      const time = `${l.period}. ${l.start}${l.end ? `-${l.end}` : ""}`;
      return `${t(language, "morning.lesson", { time, subject: l.subject })}${cancelled}`;
    })
    .join("\n");
}

/**
 * Renders the Morning report: today's Lessons, then what is due today, tomorrow and in the next days, then
 * one line for each new Item. The "New" section is left out when there are no new Items.
 */
export function formatMorningReport(
  language: Language,
  childName: string,
  today: string,
  data: Upcoming,
  newItems: readonly ItemDetail[] = [],
): string {
  const tomorrow = addDays(today, 1);
  const parts = [
    t(language, "morning.heading", { child: childName, date: dayLabel(language, today) }),
    `${t(language, "morning.lessons")}\n${lessonsText(language, today, data)}`,
    section(language, "morning.today", data.entries.filter((e) => e.date === today), false),
    section(language, "morning.tomorrow", data.entries.filter((e) => e.date === tomorrow), false),
    section(
      language,
      "morning.upcoming",
      data.entries.filter((e) => e.date > tomorrow && e.date <= addDays(today, WEEK_DAYS)),
      true,
    ),
    ...newItemsSection(language, newItems),
  ];
  if (!data.timetableOk) parts.push(t(language, "morning.timetable_warning"));
  return parts.join("\n\n");
}

/** Returns true when the UTC hour is the hour of the report and the local day is a weekday. */
export function isMorningReportRun(date: Date, timezone: string): boolean {
  const { weekday } = zonedParts(date, timezone);
  return weekday <= 5 && date.getUTCHours() === MORNING_REPORT_UTC_HOUR;
}

export interface MorningReportDeps {
  storage: StorageAdapter;
  familyId: string;
  child: ChildRef;
  recipients: readonly Recipient[];
  source: LibrusSource;
  timezone: string;
  now: Date;
  afterSchool?: AfterSchool;
  log?: (message: string) => void;
}

async function afterSchoolSection(deps: MorningReportDeps, day: string, language: Language): Promise<string[]> {
  if (!deps.afterSchool) return [];
  try {
    return [await deps.afterSchool(deps.child, day, language)];
  } catch (error) {
    deps.log?.(`after-school section failed: ${error instanceof Error ? error.message : String(error)}`);
    return [t(language, "afterschool.failed")];
  }
}

/** Returns the start of the "New" window: 24 hours before the run, or 72 hours on Monday. */
export function newItemsSince(now: Date, timezone: string): Date {
  const days = zonedParts(now, timezone).weekday === 1 ? MONDAY_WINDOW_DAYS : 1;
  return new Date(now.getTime() - days * DAY_MS);
}

/**
 * Queues the Morning report for each Recipient of the Child, in the language of the Recipient. The key is
 * `report:<child>:<day>:<chat>`, so each Recipient gets one report a day. Returns true when the run is a
 * report run.
 */
export async function runMorningReport(deps: MorningReportDeps): Promise<boolean> {
  if (!isMorningReportRun(deps.now, deps.timezone)) return false;
  const today = localDate(deps.now, deps.timezone);
  const data = await upcoming(deps.source, { child: deps.child, from: today, days: WEEK_DAYS });
  const newItems = await deps.storage.listDetails(deps.familyId, {
    childId: deps.child.id,
    since: newItemsSince(deps.now, deps.timezone),
  });
  const entries: NewNotification[] = [];
  for (const recipient of deps.recipients) {
    const language = recipient.language;
    const sections = await afterSchoolSection(deps, today, language);
    const text = [formatMorningReport(language, deps.child.name, today, data, newItems), ...sections].join("\n\n");
    entries.push({
      key: `report:${deps.child.id}:${today}:${recipient.telegram_chat_id}`,
      familyId: deps.familyId,
      chatId: recipient.telegram_chat_id,
      text,
    });
  }
  await deps.storage.enqueueNotifications(entries);
  deps.log?.(`morning report: ${data.entries.length} entries, queued for ${deps.recipients.length} recipients`);
  return true;
}
