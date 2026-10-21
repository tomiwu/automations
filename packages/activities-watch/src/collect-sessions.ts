import type { Runtime } from "@automations/shared";
import type { StorageAdapter } from "@automations/librus-data";
import { createSource, type CreateSource } from "./source.ts";
import type { Session } from "./sessions.ts";
import { activityTargets } from "./targets.ts";

export interface SessionsResult {
  /** All Sessions of all Children, ordered by start. */
  sessions: Session[];
  /** One text for each Account that failed. The other Accounts still give their Sessions. */
  errors: string[];
}

export interface CollectDeps {
  runtime: Runtime;
  storage: StorageAdapter;
  familyId: string;
  createSource?: CreateSource;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Reads the Sessions of every ActiveNow and Edusky Account, or only of one Child. A failing Account gives
 * an error text, not a rejection.
 */
export async function collectSessions(deps: CollectDeps, childId?: string): Promise<SessionsResult> {
  const config = await deps.storage.loadConfig(deps.familyId);
  const { targets, errors } = activityTargets(config);
  const result: SessionsResult = { sessions: [], errors: [...errors] };
  const make = deps.createSource ?? createSource(deps.runtime);
  for (const target of targets.filter((candidate) => childId === undefined || candidate.child.id === childId)) {
    try {
      result.sessions.push(...(await make(target, config.family.timezone).sessions()));
    } catch (error) {
      result.errors.push(`${target.child.name} ${target.account.service}: ${messageOf(error)}`);
    }
  }
  result.sessions.sort((a, b) => a.start.localeCompare(b.start));
  return result;
}
