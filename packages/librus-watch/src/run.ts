import {
  belowReserve,
  formatFetchCount,
  formatReserveSkip,
  isFetchCapError,
  localDate,
  validateConfig,
  type Account,
  type Child,
  type Config,
  type FetchBudget,
  type FetchCounter,
  type RawConfig,
  type Recipient,
  type Runtime,
} from "@automations/shared";
import type { StorageAdapter } from "@automations/librus-data";
import { deliverPending, redactSecretPlaceholders, type Messenger } from "./deliver.ts";
import { checkChild, WATCHERS_IN_ORDER, type ChildCheck } from "./engine.ts";
import { appendLibrusJournal } from "./journal-librus.ts";
import { formatAccountError, formatLoginError } from "./format.ts";
import { nameOptionsFor, type NameStore } from "./names-cache.ts";
import { runMorningReport, type AfterSchool } from "./morning-report.ts";
import { createLibrusSource } from "./source.ts";
import type { HomeworkItem, LibrusSource, WatcherName } from "./types.ts";

const FAILURE_DETAIL_MAX = 300;

export interface RunDeps {
  runtime: Runtime;
  storage: StorageAdapter;
  messenger: Messenger;
  familyId: string;
  createSource?: (account: Account, timezone: string) => LibrusSource;
  afterSchool?: AfterSchool;
  nameStore?: NameStore;
  counter?: FetchCounter;
  budget?: FetchBudget;
  fetchReserve?: number;
}

export const OPTIONAL_WATCHERS: readonly WatcherName[] = ["grades", "messages", "announcements", "trips", "absences", "meetings"];

export async function watchersFor(deps: RunDeps): Promise<readonly WatcherName[]> {
  if (!(await belowReserve(deps.budget, deps.fetchReserve))) return WATCHERS_IN_ORDER;
  deps.runtime.log("warn", formatReserveSkip(OPTIONAL_WATCHERS));
  return WATCHERS_IN_ORDER.filter((watcher) => !OPTIONAL_WATCHERS.includes(watcher));
}

async function recordFetches(deps: RunDeps, failures: readonly string[]): Promise<void> {
  if (!deps.budget || !deps.counter) return;
  try {
    await deps.budget.record(deps.counter.count().total, failures.some(isFetchCapError));
  } catch (error) {
    deps.runtime.log("warn", `fetch ledger: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export interface LibrusTarget {
  account: Account;
  child: Child;
  recipients: Recipient[];
}

/** Returns the enabled Librus Accounts of the Children with `has_librus`. A bad Account gives one error. */
export function librusTargets(config: Config): { targets: LibrusTarget[]; errors: string[] } {
  const validation = validateConfig(config as unknown as RawConfig);
  const targets: LibrusTarget[] = [];
  for (const account of validation.accounts.filter((a) => a.service === "librus")) {
    const child = config.children.find((c) => c.id === account.child_id);
    if (!child?.has_librus) continue;
    const recipients = validation.recipients.filter((r) => r.child_ids.includes(child.id));
    targets.push({ account, child, recipients });
  }
  return { targets, errors: validation.errors.map((error) => error.message) };
}

function failureText(failures: string[]): { login: boolean; reason: string } {
  const login = failures.some((failure) => failure.includes("login rejected"));
  const detail = redactSecretPlaceholders(failures.join("; ")).replace(/\s+/g, " ").trim();
  const reason = detail.length > FAILURE_DETAIL_MAX ? `${detail.slice(0, FAILURE_DETAIL_MAX - 1)}…` : detail;
  return { login, reason };
}

async function notifyFailure(deps: RunDeps, target: LibrusTarget, failures: string[], day: string): Promise<void> {
  const { login, reason } = failureText(failures);
  const entries = target.recipients.map((recipient) => {
    const context = { language: recipient.language, child: target.child.name };
    return {
      key: `failure:${target.account.id}:${day}:${recipient.telegram_chat_id}`,
      familyId: deps.familyId,
      chatId: recipient.telegram_chat_id,
      text: login ? formatLoginError(context) : formatAccountError(context, reason),
    };
  });
  await deps.storage.enqueueNotifications(entries);
}

async function journalStep(
  deps: RunDeps,
  config: Config,
  target: LibrusTarget,
  source: LibrusSource,
  homework: HomeworkItem[] | undefined,
  log: (message: string) => void,
): Promise<string[]> {
  try {
    await appendLibrusJournal({
      storage: deps.storage,
      familyId: deps.familyId,
      childId: target.child.id,
      source,
      timezone: config.family.timezone,
      now: deps.runtime.now(),
      homework,
      log,
    });
    return [];
  } catch (error) {
    return [`journal: ${error instanceof Error ? error.message : String(error)}`];
  }
}

async function runTarget(
  deps: RunDeps,
  config: Config,
  target: LibrusTarget,
  watchers: readonly WatcherName[],
): Promise<string[]> {
  const { runtime, storage, familyId } = deps;
  const timezone = config.family.timezone;
  const source = deps.createSource?.(target.account, timezone) ??
    createLibrusSource(runtime, target.account, {
      timezone,
      names: nameOptionsFor(deps.nameStore, target.account.id),
    });
  const log = (message: string) => runtime.log("info", `account ${target.account.id}: ${message}`);
  const check: ChildCheck = { familyId, child: target.child, recipients: target.recipients, storage, source, log };
  const { failures, homework } = await checkChild(check, watchers);
  failures.push(...(await journalStep(deps, config, target, source, homework, log)));
  if (failures.length > 0) await notifyFailure(deps, target, failures, localDate(runtime.now(), timezone));
  try {
    await runMorningReport({
      storage,
      familyId,
      child: target.child,
      recipients: target.recipients,
      source,
      timezone,
      now: runtime.now(),
      afterSchool: deps.afterSchool,
      log,
    });
  } catch (error) {
    runtime.log("warn", `morning report failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return failures.map((failure) => `${target.child.name}: ${failure}`);
}

async function deliverAll(deps: RunDeps, config: Config): Promise<string[]> {
  try {
    await deliverPending({
      storage: deps.storage,
      familyId: deps.familyId,
      messenger: deps.messenger,
      chatIds: config.recipients.map((recipient) => recipient.telegram_chat_id),
      log: (message) => deps.runtime.log("info", message),
    });
    return [];
  } catch (error) {
    return [`deliver: ${error instanceof Error ? error.message : String(error)}`];
  }
}

/**
 * Runs one scheduled pass. It loads the config from storage, runs the Watchers of each Librus Account,
 * queues the Morning report on report runs, and delivers the Outbox. A bad Account gives one error and the
 * other Accounts still run. Returns all failure texts. The caller rejects when the list is not empty.
 */
export async function runLibrusWatch(deps: RunDeps): Promise<string[]> {
  const config = await deps.storage.loadConfig(deps.familyId);
  const { targets, errors } = librusTargets(config);
  const failures = [...errors];
  const watchers = await watchersFor(deps);
  for (const target of targets) failures.push(...(await runTarget(deps, config, target, watchers)));
  failures.push(...(await deliverAll(deps, config)));
  for (const failure of failures) deps.runtime.log("error", redactSecretPlaceholders(failure));
  if (deps.counter) deps.runtime.log("info", formatFetchCount(deps.counter.count()));
  await recordFetches(deps, failures);
  return failures;
}
