import { localDate, t, type Config, type Runtime } from "@automations/shared";
import type { StorageAdapter } from "@automations/librus-data";
import { deliverPending, type Messenger } from "@tomiwu/librus-watch";
import { runWatcher } from "./engine.ts";
import { createSource, type CreateSource } from "./source.ts";
import { activityTargets, type ActivityTarget } from "./targets.ts";

const FAILURE_DETAIL_MAX = 300;

export interface RunDeps {
  runtime: Runtime;
  storage: StorageAdapter;
  messenger: Messenger;
  familyId: string;
  /** Makes the source of one Account. The default reads the app. The tests replace it. */
  createSource?: CreateSource;
}

/** Returns the scope of the Items of one Account. */
export const scopeOf = (target: ActivityTarget): string => `${target.account.service}:${target.account.id}`;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function failureReason(message: string): string {
  const detail = message.replace(/\{\{\s*secret[^}]*\}\}/gi, "[secret]").replace(/\s+/g, " ").trim();
  return detail.length > FAILURE_DETAIL_MAX ? `${detail.slice(0, FAILURE_DETAIL_MAX - 1)}…` : detail;
}

/** Queues one failure Notification for each Recipient of the Child. The key has the day, so it is sent once a day. */
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

async function runTarget(deps: RunDeps, config: Config, target: ActivityTarget): Promise<string | undefined> {
  const { runtime } = deps;
  const timezone = config.family.timezone;
  const source = (deps.createSource ?? createSource(runtime))(target, timezone);
  try {
    await runWatcher({
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
    return undefined;
  } catch (error) {
    runtime.log("info", `account ${target.account.id}: fail`);
    await notifyFailure(deps, target, messageOf(error), localDate(runtime.now(), timezone));
    return `${target.child.name} ${target.account.service}: ${messageOf(error)}`;
  }
}

/**
 * Runs one scheduled pass. It loads the config from storage, runs the Watcher of each ActiveNow and
 * Edusky Account, and delivers the Outbox. A bad Account gives one error and the other Accounts still
 * run. Returns all failure texts. The caller rejects when the list is not empty.
 */
export async function runActivitiesWatch(deps: RunDeps): Promise<string[]> {
  const config = await deps.storage.loadConfig(deps.familyId);
  const { targets, errors } = activityTargets(config);
  const failures = [...errors];
  for (const target of targets) {
    const failure = await runTarget(deps, config, target);
    if (failure) failures.push(failure);
  }
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
  return failures;
}
