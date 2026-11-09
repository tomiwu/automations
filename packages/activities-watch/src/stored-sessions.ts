import { addDays, formatFetchCount, localDate, type FetchCount, type FetchCounter, type Runtime } from "@automations/shared";
import { projectHeads, type StorageAdapter, type StreamState } from "@automations/librus-data";
import { checkKeys, DAY_PATTERN, inputObject } from "./exports.ts";
import type { Session, SessionStatus } from "./sessions.ts";
import { activityTargets } from "./targets.ts";

const DEFAULT_SPAN_DAYS = 13;
const MAX_DAYS = 60;
const DAY_MS = 86_400_000;

export interface StoredSessionsDeps {
  runtime: Pick<Runtime, "now" | "log">;
  storage: StorageAdapter;
  familyId: string;
  /** Counts the fetches of the run. With it the export logs the count and returns it as `fetches`. */
  counter?: FetchCounter;
}

export interface StoredSession {
  id: string;
  stream: string;
  childId: string;
  child: string;
  activity: string;
  service: Session["service"];
  start: string;
  end: string;
  place: string;
  status: SessionStatus;
  warning: string | null;
  vanished: boolean;
  seq: number;
  lastChanged: string;
}

export interface StoredAccount {
  accountId: string;
  childId: string;
  service: string;
  lastSavedAt: string | null;
}

export interface StoredSessionsExport {
  timezone: string;
  from: string;
  to: string;
  accounts: StoredAccount[];
  sessions: StoredSession[];
}

function checkDay(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !DAY_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be a date YYYY-MM-DD.`);
  }
  return value;
}

function resolveRange(object: Record<string, unknown>, today: string): { from: string; to: string } {
  const from = checkDay("from", object.from) ?? today;
  const to = checkDay("to", object.to) ?? addDays(from, DEFAULT_SPAN_DAYS);
  const span = (Date.parse(to) - Date.parse(from)) / DAY_MS;
  if (span < 0) throw new Error("to must not be before from.");
  if (span > MAX_DAYS) throw new Error(`to - from must be at most ${MAX_DAYS} days.`);
  return { from, to };
}

function checkChildId(childId: unknown): string | undefined {
  if (childId !== undefined && typeof childId !== "string") throw new Error("childId must be a text.");
  return childId;
}

function sessionOf(head: StreamState, childNames: ReadonlyMap<string, string>): StoredSession {
  const [, childId = "", ...rest] = head.stream.split(":");
  const s = head.state as unknown as Session & { warning: string | null };
  return {
    id: rest.join(":"), stream: head.stream, childId, child: childNames.get(childId) ?? "", activity: s.activity, service: s.service,
    start: s.start, end: s.end, place: s.place, status: s.status, warning: s.warning ?? null,
    vanished: head.vanished, seq: head.seq, lastChanged: head.lastChanged.toISOString(),
  };
}

function withFetches<T extends object>(deps: StoredSessionsDeps, result: T): T & { fetches?: FetchCount } {
  if (!deps.counter) return result;
  const fetches = deps.counter.count();
  deps.runtime.log("info", formatFetchCount(fetches));
  return { ...result, fetches };
}

/**
 * Read-only export: the Sessions of the Children as the Journal stores them. It reads Supabase only: no app
 * login. Vanished Sessions stay in the result with `vanished: true`.
 */
export async function storedSessionsExport(deps: StoredSessionsDeps, input: unknown = {}): Promise<StoredSessionsExport & { fetches?: FetchCount }> {
  const object = inputObject(input);
  checkKeys(object, ["childId", "from", "to"]);
  const childId = checkChildId(object.childId);
  const config = await deps.storage.loadConfig(deps.familyId);
  if (childId !== undefined && !config.children.some((child) => child.id === childId)) throw new Error(`Unknown child: ${childId}.`);
  const timezone = config.family.timezone;
  const { from, to } = resolveRange(object, localDate(deps.runtime.now(), timezone));
  const targets = activityTargets(config).targets.filter((target) => childId === undefined || target.child.id === childId);
  const heads = await deps.storage.listHeads(deps.familyId, { kinds: ["session"], ...(childId === undefined ? {} : { childId }), from, to });
  const streams = targets.map((target) => `check:activities-watch:${target.account.id}`);
  const checks = streams.length === 0 ? [] : await deps.storage.listHeads(deps.familyId, { streams });
  const saved = new Map(checks.map((head) => [head.stream, head.recordedAt.toISOString()]));
  const names = new Map(config.children.map((child) => [child.id, child.name]));
  const sessions = projectHeads(heads).map((head) => sessionOf(head, names)).sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  const accounts = targets.map(({ account }) => ({
    accountId: account.id, childId: account.child_id, service: account.service, lastSavedAt: saved.get(`check:activities-watch:${account.id}`) ?? null,
  }));
  const result = { timezone, from, to, accounts, sessions };
  return withFetches(deps, result);
}
