import {
  SERVICES,
  validateConfig,
  type Account,
  type Activity,
  type Child,
  type Config,
  type RawConfig,
  type Recipient,
  type Service,
} from "@automations/shared";
import type { Session } from "./sessions.ts";

/** The Services that this package reads. */
export const WATCHED_SERVICES: readonly Service[] = ["activenow", "edusky", "mondo"];

/** One Account with its Child, its Activities and the Recipients of the Child. */
export interface ActivityTarget {
  account: Account;
  child: Child;
  activities: Activity[];
  recipients: Recipient[];
}

function isRelevant(service: unknown): boolean {
  const known = (SERVICES as readonly unknown[]).includes(service);
  return !known || (WATCHED_SERVICES as readonly unknown[]).includes(service);
}

/**
 * Returns the enabled ActiveNow, Edusky and Mondo Accounts of the config with their Children, Activities and
 * Recipients. A bad Account gives one error. The other Accounts still run.
 */
export function activityTargets(config: Config): { targets: ActivityTarget[]; errors: string[] } {
  const validation = validateConfig(config as unknown as RawConfig);
  const services = new Map(config.accounts.map((account) => [String(account.id), account.service as unknown]));
  const targets: ActivityTarget[] = [];
  for (const account of validation.accounts.filter((a) => WATCHED_SERVICES.includes(a.service))) {
    const child = config.children.find((c) => c.id === account.child_id);
    if (!child) continue;
    targets.push({
      account,
      child,
      activities: config.activities.filter((a) => a.account_id === account.id && a.enabled),
      recipients: validation.recipients.filter((r) => r.child_ids.includes(child.id)),
    });
  }
  const errors = validation.errors
    .filter((error) => error.subject === "recipient" || isRelevant(services.get(error.id)))
    .map((error) => error.message);
  return { targets, errors };
}

/** What one read of an Account gives. */
export interface SourceReading {
  /** The Sessions for the next 14 days, ordered by start. */
  sessions: Session[];
  /** True when the Sessions come from the cache and not from the app. */
  cached: boolean;
  /** ISO time of the fetch that made the Sessions, or null when there was none. */
  fetchedAt: string | null;
  /** The error of the last fetch. The Sessions are then the cached ones. */
  error?: string;
}

/** Reads the Sessions of one Account. */
export interface SessionSource {
  /** The Sessions for the next 14 days, ordered by start. It rejects when the login or a page fails. */
  sessions(): Promise<Session[]>;
  /** Like `sessions`, but a failed fetch gives the cached Sessions and the error, and tells if they are cached. */
  read?(): Promise<SourceReading>;
}

/** Returns the Activity that names the Sessions of the Account. An Account needs one enabled Activity. */
export function firstActivity(target: ActivityTarget): Activity {
  const activity = target.activities[0];
  if (!activity) throw new Error(`Account ${target.account.id}: no enabled Activity for ${target.child.name}`);
  return activity;
}
