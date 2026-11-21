import type { StorageAdapter } from "@automations/librus-data";
import { isFetchCapError, type Runtime } from "@automations/shared";
import { deliverPending, type Messenger } from "@tomiwu/librus-watch";
import { editCancelledMessages } from "./cancel-edit.ts";
import type { Notifier, TelegramClient } from "./notifier.ts";
import { deliverPaymentPhotos, withoutPaymentEntries } from "./payment-delivery.ts";
import { recordSent } from "./sent-journal.ts";
import { logActivenowPass } from "./activenow-fee-source.ts";
import { runPayments } from "./engine.ts";
import type { FeeSource } from "./fee-source.ts";
import type { CounterStore } from "./organizer-cancel.ts";

export interface RunDeps {
  runtime: Runtime;
  storage: StorageAdapter;
  messenger: Messenger;
  familyId: string;
  source: FeeSource;
  /** The package storage for the counters of the Organizer cancel. Without it, an Organizer page cancels nothing. */
  counters?: CounterStore;
  /**
   * With a Notifier, the Payment Notifications and reminders go out as QR photos with Paid and Skip, and the text
   * delivery does not see them. Without it, they go out as text (the old path).
   */
  notifier?: Notifier;
  /** With a client, the sent QR messages of a cancelled Payment are edited (payments contract v0.2 section 3b, PC4). */
  client?: TelegramClient;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Sends the Payment photos. Returns the sent keys; a failure goes to `failures`. */
async function deliverPhotos(deps: RunDeps, storage: StorageAdapter, failures: string[]): Promise<string[]> {
  if (!deps.notifier) return [];
  try {
    const { sent, failure } = await deliverPaymentPhotos({ storage, familyId: deps.familyId, notifier: deps.notifier, log: (m) => deps.runtime.log("info", m) });
    if (failure !== undefined) failures.push(`photos: ${messageOf(failure)}`);
    return sent;
  } catch (error) {
    failures.push(`photos: ${messageOf(error)}`);
    return [];
  }
}

/** Edits the QR messages of the cancelled Payments. A failure goes to `failures`. */
async function editCancelled(deps: RunDeps, failures: string[]): Promise<void> {
  if (!deps.client) return;
  try {
    await editCancelledMessages({ storage: deps.storage, familyId: deps.familyId, client: deps.client, log: (m) => deps.runtime.log("warn", m) });
  } catch (error) {
    failures.push(`cancel edit: ${messageOf(error)}`);
  }
}

/**
 * Logs each failure. A failure on the Kody fetch limit is a warning, not a failure of the pass: the next pass
 * does the work again. Returns the other failures.
 */
function reportFailures(runtime: Runtime, failures: readonly string[]): string[] {
  for (const failure of failures) {
    runtime.log(isFetchCapError(failure) ? "warn" : "error", isFetchCapError(failure) ? `fetch cap: ${failure}` : failure);
  }
  return failures.filter((failure) => !isFetchCapError(failure));
}

/**
 * Runs one scheduled pass: the Payment engine, then the delivery of the Outbox to the Recipients.
 * Returns the failure texts. The caller rejects when the list is not empty. A failure on the Kody fetch
 * limit is logged but not returned, so the job does not fail on the weekly cap.
 */
export async function runPaymentsWatch(deps: RunDeps): Promise<string[]> {
  const { runtime, storage, familyId } = deps;
  const failures: string[] = [];
  try {
    await runPayments({ familyId, storage, source: deps.source, now: runtime.now(), counters: deps.counters });
    logActivenowPass(runtime, deps.source);
  } catch (error) {
    failures.push(`payments: ${messageOf(error)}`);
  }
  await editCancelled(deps, failures);
  const delivered: string[] = await deliverPhotos(deps, storage, failures);
  const textStorage = deps.notifier ? withoutPaymentEntries(storage) : storage;
  const watching: StorageAdapter = {
    ...textStorage,
    markDeliveredMany: async (keys) => {
      await storage.markDeliveredMany(keys);
      delivered.push(...keys);
    },
  };
  try {
    const config = await storage.loadConfig(familyId);
    await deliverPending({
      storage: watching,
      familyId,
      messenger: deps.messenger,
      chatIds: config.recipients.map((recipient) => recipient.telegram_chat_id),
      log: (message) => runtime.log("info", message),
    });
  } catch (error) {
    failures.push(`deliver: ${messageOf(error)}`);
  }
  try {
    await recordSent(storage, familyId, delivered, runtime.now());
  } catch (error) {
    failures.push(`journal: ${messageOf(error)}`);
  }
  return reportFailures(runtime, failures);
}
