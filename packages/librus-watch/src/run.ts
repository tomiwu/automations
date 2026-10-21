import {
  localDate,
  validateConfig,
  type Account,
  type Child,
  type Config,
  type RawConfig,
  type Recipient,
  type Runtime,
} from "@automations/shared";
import type { StorageAdapter } from "@automations/librus-data";
import { deliverPending, redactSecretPlaceholders, type Messenger } from "./deliver.ts";
import { runChildCheck, type ChildCheck } from "./engine.ts";
import { formatAccountError, formatLoginError } from "./format.ts";
import { runMorningReport, type AfterSchool } from "./morning-report.ts";
import { createLibrusSource } from "./source.ts";
import type { LibrusSource } from "./types.ts";

const FAILURE_DETAIL_MAX = 300;

export interface RunDeps {
  runtime: Runtime;
  storage: StorageAdapter;
  messenger: Messenger;
  familyId: string;
  /** Makes the source of one Account. The default reads Librus. The tests replace it. */
  createSource?: (account: Account, timezone: string) => LibrusSource;
  afterSchool?: AfterSchool;
}

/** One Librus Account with its Child and the Recipients of that Child. */
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

/** Queues one failure Notification for each Recipient of the Child. The key has the day, so it is sent once a day. */
async function notifyFailure(deps: RunDeps, target: LibrusTarget, failures: string[], day: string): Promise<void> {
  const { login, reason } = failureText(failures);
  for (const recipient of target.recipients) {
    const context = { language: recipient.language, child: target.child.name };
    await deps.storage.enqueueNotification({
      key: `failure:${target.account.id}:${day}:${recipient.telegram_chat_id}`,
      familyId: deps.familyId,
      chatId: recipient.telegram_chat_id,
      text: login ? formatLoginError(context) : formatAccountError(context, reason),
    });
  }
}

async function runTarget(deps: RunDeps, config: Config, target: LibrusTarget): Promise<string[]> {
  const { runtime, storage, familyId } = deps;
  const timezone = config.family.timezone;
  const source = deps.createSource?.(target.account, timezone) ?? createLibrusSource(runtime, target.account, { timezone });
  const log = (message: string) => runtime.log("info", `account ${target.account.id}: ${message}`);
  const check: ChildCheck = { familyId, child: target.child, recipients: target.recipients, storage, source, log };
  const failures = await runChildCheck(check);
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

/**
 * Runs one scheduled pass. It loads the config from storage, runs the Watchers of each Librus Account,
 * queues the Morning report on report runs, and delivers the Outbox. A bad Account gives one error and the
 * other Accounts still run. Returns all failure texts. The caller rejects when the list is not empty.
 */
export async function runLibrusWatch(deps: RunDeps): Promise<string[]> {
  const config = await deps.storage.loadConfig(deps.familyId);
  const { targets, errors } = librusTargets(config);
  const failures = [...errors];
  for (const target of targets) failures.push(...(await runTarget(deps, config, target)));
  const chatIds = config.recipients.map((recipient) => recipient.telegram_chat_id);
  try {
    await deliverPending({
      storage: deps.storage,
      familyId: deps.familyId,
      messenger: deps.messenger,
      chatIds,
      log: (message) => deps.runtime.log("info", message),
    });
  } catch (error) {
    failures.push(`deliver: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const failure of failures) deps.runtime.log("error", redactSecretPlaceholders(failure));
  return failures;
}
