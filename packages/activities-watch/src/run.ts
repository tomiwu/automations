import {
  belowReserve,
  formatReserveSkip,
  isFetchCapError,
  localDate,
  t,
  type Config,
  type FetchBudget,
  type FetchCounter,
  type Runtime,
} from "@automations/shared";
import type { StorageAdapter } from "@automations/librus-data";
import { deliverPending, type Messenger } from "@tomiwu/librus-watch";
import type { ActiveNowOptions } from "./activenow-source.ts";
import { runWatcher } from "./engine.ts";
import { appendSessionsJournal, type AccountSessions } from "./journal-sessions.ts";
import type { Session } from "./sessions.ts";
import { createSource, type CreateSource } from "./source.ts";
import { activityTargets, type ActivityTarget } from "./targets.ts";

const FAILURE_DETAIL_MAX = 300;

export interface RunDeps {
  runtime: Runtime;
  storage: StorageAdapter;
  messenger: Messenger;
  familyId: string;
  createSource?: CreateSource;
  activeNow?: ActiveNowOptions;
  counter?: FetchCounter;
  /** The weekly fetch ledger. Below the reserve, ActiveNow uses its cache and does not fetch again. */
  budget?: FetchBudget;
  fetchReserve?: number;
}

export const RESERVE_ACTIVENOW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function withReserve(deps: RunDeps): Promise<RunDeps> {
  if (!deps.activeNow?.store || !(await belowReserve(deps.budget, deps.fetchReserve))) return deps;
  deps.runtime.log("warn", formatReserveSkip(["activenow refresh"]));
  return { ...deps, activeNow: { ...deps.activeNow, ttlMs: RESERVE_ACTIVENOW_TTL_MS } };
}

async function recordFetches(deps: RunDeps, failures: readonly string[]): Promise<void> {
  if (!deps.budget || !deps.counter) return;
  try {
    await deps.budget.record(deps.counter.count().total, failures.some(isFetchCapError));
  } catch (error) {
    deps.runtime.log("warn", `fetch ledger: ${messageOf(error)}`);
  }
}

export const scopeOf = (target: ActivityTarget): string => `${target.account.service}:${target.account.id}`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function failureReason(message: string): string {
  const detail = message.replace(/\{\{\s*secret[^}]*\}\}/gi, "[secret]").replace(/\s+/g, " ").trim();
  return detail.length > FAILURE_DETAIL_MAX ? `${detail.slice(0, FAILURE_DETAIL_MAX - 1)}…` : detail;
}

async function notifyFailure(deps: RunDeps, target: ActivityTarget, message: string, day: string): Promise<void> {
  const login = message.includes("login rejected");
  for (const recipient of target.recipients) {
    const params = { child: target.child.name, reason: failureReason(message) };
    await deps.storage.enqueueNotification({
      key: `failure:${target.account.id}:${day}:${recipient.telegram_chat_id}`,
      familyId: deps.familyId,
      chatId: recipient.telegram_chat_id,
      text: t(recipient.language, login ? "error.login" : "error.fetch", params),
    });
  }
}

type TargetResult = { sessions: Session[]; failure?: undefined } | { failure: string; sessions?: undefined };

async function runTarget(deps: RunDeps, config: Config, target: ActivityTarget): Promise<TargetResult> {
  const { runtime } = deps;
  const timezone = config.family.timezone;
  const source = (deps.createSource ?? createSource(runtime, deps.activeNow))(target, timezone);
  try {
    const sessions = await runWatcher({
      familyId: deps.familyId,
      child: target.child,
      recipients: target.recipients,
      scope: scopeOf(target),
      storage: deps.storage,
      source,
      now: runtime.now(),
      timezone,
    });
    runtime.log("info", `account ${target.account.id}: ok`);
    return { sessions };
  } catch (error) {
    runtime.log("info", `account ${target.account.id}: fail`);
    await notifyFailure(deps, target, messageOf(error), localDate(runtime.now(), timezone));
    return { failure: `${target.child.name} ${target.account.service}: ${messageOf(error)}` };
  }
}

async function journalStep(deps: RunDeps, config: Config, accounts: AccountSessions[]): Promise<string[]> {
  try {
    await appendSessionsJournal({
      storage: deps.storage,
      familyId: deps.familyId,
      accounts,
      timezone: config.family.timezone,
      now: deps.runtime.now(),
      log: (message) => deps.runtime.log("info", message),
    });
    return [];
  } catch (error) {
    return [`journal: ${messageOf(error)}`];
  }
}

/**
 * Runs one scheduled pass. It loads the config from storage, runs the Watcher of each ActiveNow and
 * Edusky Account, and delivers the Outbox. A bad Account gives one error and the other Accounts still
 * run. Returns all failure texts. The caller rejects when the list is not empty.
 */
export async function runActivitiesWatch(input: RunDeps): Promise<string[]> {
  const deps = await withReserve(input);
  const config = await deps.storage.loadConfig(deps.familyId);
  const { targets, errors } = activityTargets(config);
  const failures = [...errors];
  const read: AccountSessions[] = [];
  for (const target of targets) {
    const result = await runTarget(deps, config, target);
    if (result.failure !== undefined) failures.push(result.failure);
    else read.push({ target, sessions: result.sessions });
  }
  failures.push(...(await journalStep(deps, config, read)));
  try {
    await deliverPending({
      storage: deps.storage,
      familyId: deps.familyId,
      messenger: deps.messenger,
      chatIds: config.recipients.map((recipient) => recipient.telegram_chat_id),
      log: (message) => deps.runtime.log("info", message),
    });
  } catch (error) {
    failures.push(`deliver: ${messageOf(error)}`);
  }
  for (const failure of failures) deps.runtime.log("error", failureReason(failure));
  await recordFetches(deps, failures);
  return failures;
}
