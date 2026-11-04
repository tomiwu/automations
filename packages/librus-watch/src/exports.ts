import { formatFetchCount, localDate, type Account, type FetchCount, type FetchCounter, type Runtime } from "@automations/shared";
import type { StorageAdapter } from "@automations/librus-data";
import { checkDay, checkSince, sortEvents, toEvent, type CalendarEvent } from "./events.ts";
import { readCalendar, type CalendarResult } from "./calendar.ts";
import { nameOptionsFor, type NameStore } from "./names-cache.ts";
import { readLessons, type LessonsResult } from "./lessons.ts";
import { librusTargets, type LibrusTarget } from "./run.ts";
import { createLibrusSource } from "./source.ts";
import { upcoming, type UpcomingEntry } from "./upcoming.ts";
import type { LibrusSource } from "./types.ts";

export const MAX_DAYS = 60;

export interface ExportDeps {
  runtime: Runtime;
  storage: StorageAdapter;
  familyId: string;
  /** Makes the source of one Account. The default reads Librus. The tests replace it. */
  createSource?: (account: Account, timezone: string) => LibrusSource;
  /** Keeps the Librus names between runs. Without it each export fetches the names again. */
  nameStore?: NameStore;
  /** Counts the fetches of the run. With it the export logs the count and returns it as `fetches`. */
  counter?: FetchCounter;
}

/** Logs the fetch count of the export and adds it to the result. Without a counter the result is as it is. */
export function withFetches<T extends object>(deps: ExportDeps, result: T): T & { fetches?: FetchCount } {
  if (!deps.counter) return result;
  const fetches = deps.counter.count();
  deps.runtime.log("info", formatFetchCount(fetches));
  return { ...result, fetches };
}

interface ExportInput {
  childId?: string;
  days: number;
}

function inputObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Input must be an object.");
  return input as Record<string, unknown>;
}

function checkKeys(object: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown input key(s): ${unknown.join(", ")}.`);
}

function checkChildId(childId: unknown): string | undefined {
  if (childId !== undefined && typeof childId !== "string") throw new Error("childId must be a text.");
  return childId;
}

function checkDays(days: unknown): number {
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > MAX_DAYS) {
    throw new Error(`days must be an integer 0..${MAX_DAYS}.`);
  }
  return days;
}

/** Checks the input of an export. Unknown keys, a bad `childId` and a bad `days` give an error. */
export function parseExportInput(input: unknown, allowed: readonly ("childId" | "days")[]): ExportInput {
  const object = inputObject(input);
  checkKeys(object, allowed);
  return { childId: checkChildId(object.childId), days: checkDays(object.days ?? MAX_DAYS) };
}

/** Picks the Librus Account of the Child. Without a `childId` the Family must have one Librus Child. */
export function pickTarget(targets: readonly LibrusTarget[], childId: string | undefined): LibrusTarget {
  if (childId === undefined) return onlyTarget(targets);
  const target = targets.find((candidate) => candidate.child.id === childId);
  if (!target) throw new Error(`Unknown child: ${childId}.`);
  return target;
}

function onlyTarget(targets: readonly LibrusTarget[]): LibrusTarget {
  const [target] = targets;
  if (!target) throw new Error("No Librus Account in the config.");
  if (targets.some((other) => other.child.id !== target.child.id)) {
    throw new Error("The Family has more than one Child with Librus. Give childId.");
  }
  return target;
}

async function openTarget(deps: ExportDeps, childId: string | undefined) {
  const config = await deps.storage.loadConfig(deps.familyId);
  const target = pickTarget(librusTargets(config).targets, childId);
  const timezone = config.family.timezone;
  const source =
    deps.createSource?.(target.account, timezone) ??
    createLibrusSource(deps.runtime, target.account, {
      timezone,
      names: nameOptionsFor(deps.nameStore, target.account.id),
    });
  return { target, source, timezone };
}

export interface UpcomingExport {
  childId: string;
  child: string;
  timezone: string;
  from: string;
  to: string;
  timetableOk: boolean;
  entries: UpcomingEntry[];
}

/** Read-only export: upcoming homework and tests of one Child, each with the first Lesson of its subject that day. */
export async function upcomingExport(deps: ExportDeps, input: unknown = {}): Promise<UpcomingExport & { fetches?: FetchCount }> {
  const { childId, days } = parseExportInput(input, ["childId", "days"]);
  const { target, source, timezone } = await openTarget(deps, childId);
  const from = localDate(deps.runtime.now(), timezone);
  const { entries, to, timetableOk } = await upcoming(source, { child: target.child, from, days });
  return withFetches(deps, { childId: target.child.id, child: target.child.name, timezone, from, to, timetableOk, entries });
}

export interface LessonsExport extends LessonsResult {
  childId: string;
  child: string;
  timezone: string;
}

/** Read-only export: the Lessons of one Child for the next 14 days. */
export async function lessonsExport(deps: ExportDeps, input: unknown = {}): Promise<LessonsExport & { fetches?: FetchCount }> {
  const { childId } = parseExportInput(input, ["childId"]);
  const { target, source, timezone } = await openTarget(deps, childId);
  const result = await readLessons(source, target.child);
  return withFetches(deps, { childId: target.child.id, child: target.child.name, timezone, ...result });
}

export interface CalendarExport extends CalendarResult {
  childId: string;
  child: string;
  timezone: string;
}

/**
 * Read-only export: the Lessons of the next 14 days and the homework and tests of the same days, in one read
 * with one Librus login. It replaces a `lessons` call plus an `upcoming` call.
 */
export async function calendarExport(deps: ExportDeps, input: unknown = {}): Promise<CalendarExport & { fetches?: FetchCount }> {
  const { childId } = parseExportInput(input, ["childId"]);
  const { target, source, timezone } = await openTarget(deps, childId);
  const result = await readCalendar(source, target.child, localDate(deps.runtime.now(), timezone));
  return withFetches(deps, { childId: target.child.id, child: target.child.name, timezone, ...result });
}

export interface ChildrenExport {
  children: { id: string; name: string; calendar_id: string | null }[];
}

/** Read-only export: every Child of the Family, so a calendar agent finds the calendars. */
export async function childrenExport(deps: ExportDeps, input: unknown = {}): Promise<ChildrenExport & { fetches?: FetchCount }> {
  checkKeys(inputObject(input), []);
  const config = await deps.storage.loadConfig(deps.familyId);
  return withFetches(deps, { children: config.children.map(({ id, name, calendar_id }) => ({ id, name, calendar_id })) });
}

export interface EventsExport {
  childId: string;
  child: string;
  from: string | null;
  to: string | null;
  since: string;
  events: CalendarEvent[];
}

/**
 * Read-only export: the stored content of the Items of one Child (meetings, days off, trips, Terminarz entries,
 * announcements, messages, grades). It reads Supabase only: no Librus login. The calendar routine places the events.
 */
export async function eventsExport(deps: ExportDeps, input: unknown = {}): Promise<EventsExport & { fetches?: FetchCount }> {
  const object = inputObject(input);
  checkKeys(object, ["childId", "from", "to", "since"]);
  const childId = checkChildId(object.childId);
  const from = checkDay("from", object.from);
  const to = checkDay("to", object.to);
  const since = checkSince(object.since, deps.runtime.now());
  const config = await deps.storage.loadConfig(deps.familyId);
  const { child } = pickTarget(librusTargets(config).targets, childId);
  const details = await deps.storage.listDetails(deps.familyId, { childId: child.id, from, to, since });
  const events = sortEvents(await Promise.all(details.map((detail) => toEvent(detail, config.family.timezone))));
  return withFetches(deps, { childId: child.id, child: child.name, from: from ?? null, to: to ?? null, since: since.toISOString(), events });
}
