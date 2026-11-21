import type { Runtime } from "@automations/shared";
import type { StorageAdapter } from "@automations/librus-data";
import type { ActiveNowOptions } from "./activenow-source.ts";
import { createSource, type CreateSource } from "./source.ts";
import type { Session } from "./sessions.ts";
import { activityTargets, type ActivityTarget, type SessionSource } from "./targets.ts";

export interface SessionsResult {
  /** All Sessions of all Children, ordered by start. */
  sessions: Session[];
  /** One text for each Account that failed. The other Accounts still give their Sessions. */
  errors: string[];
  /** How each Account was read. `cached` is true when its Sessions come from the cache, not from the app. */
  accounts: AccountReading[];
}

export interface AccountReading {
  accountId: string;
  service: string;
  cached: boolean;
  fetchedAt: string | null;
}

export interface CollectDeps {
  runtime: Runtime;
  storage: StorageAdapter;
  familyId: string;
  createSource?: CreateSource;
  activeNow?: ActiveNowOptions;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function readTarget(result: SessionsResult, source: SessionSource, target: ActivityTarget): Promise<void> {
  const reading = source.read ? await source.read() : { sessions: await source.sessions(), cached: false, fetchedAt: null };
  result.sessions.push(...reading.sessions);
  result.accounts.push({ accountId: target.account.id, service: target.account.service, cached: reading.cached, fetchedAt: reading.fetchedAt });
  if (reading.error !== undefined) result.errors.push(`${target.child.name} ${target.account.service}: ${reading.error}`);
}

/**
 * Reads the Sessions of every ActiveNow and Edusky Account, or only of one Child. A failing Account gives
 * an error text, not a rejection.
 */
export async function collectSessions(deps: CollectDeps, childId?: string): Promise<SessionsResult> {
  const config = await deps.storage.loadConfig(deps.familyId);
  const { targets, errors } = activityTargets(config);
  const result: SessionsResult = { sessions: [], errors: [...errors], accounts: [] };
  const make = deps.createSource ?? createSource(deps.runtime, deps.activeNow);
  for (const target of targets.filter((candidate) => childId === undefined || candidate.child.id === childId)) {
    try {
      await readTarget(result, make(target, config.family.timezone), target);
    } catch (error) {
      result.errors.push(`${target.child.name} ${target.account.service}: ${messageOf(error)}`);
    }
  }
  result.sessions.sort((a, b) => a.start.localeCompare(b.start));
  return result;
}
