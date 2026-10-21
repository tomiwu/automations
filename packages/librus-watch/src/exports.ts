import { localDate, type Account, type Runtime } from "@automations/shared";
import type { StorageAdapter } from "@automations/librus-data";
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
    deps.createSource?.(target.account, timezone) ?? createLibrusSource(deps.runtime, target.account, { timezone });
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
export async function upcomingExport(deps: ExportDeps, input: unknown = {}): Promise<UpcomingExport> {
  const { childId, days } = parseExportInput(input, ["childId", "days"]);
  const { target, source, timezone } = await openTarget(deps, childId);
  const from = localDate(deps.runtime.now(), timezone);
  const { entries, to, timetableOk } = await upcoming(source, { child: target.child, from, days });
  return { childId: target.child.id, child: target.child.name, timezone, from, to, timetableOk, entries };
}

export interface LessonsExport extends LessonsResult {
  childId: string;
  child: string;
  timezone: string;
}

/** Read-only export: the Lessons of one Child for the next 14 days. */
export async function lessonsExport(deps: ExportDeps, input: unknown = {}): Promise<LessonsExport> {
  const { childId } = parseExportInput(input, ["childId"]);
  const { target, source, timezone } = await openTarget(deps, childId);
  const result = await readLessons(source, target.child);
  return { childId: target.child.id, child: target.child.name, timezone, ...result };
}
