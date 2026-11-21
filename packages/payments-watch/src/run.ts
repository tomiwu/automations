import type { StorageAdapter } from "@automations/librus-data";
import { isFetchCapError, type Runtime } from "@automations/shared";
import { deliverPending, type Messenger } from "@tomiwu/librus-watch";
import { editCancelledMessages } from "./cancel-edit.ts";
import type { Notifier, TelegramClient } from "./notifier.ts";
import { deliverPaymentPhotos, withoutPaymentEntries } from "./payment-delivery.ts";
import { recordSent } from "./sent-journal.ts";
import { runPayments } from "./engine.ts";
import type { FeeSource } from "./fee-source.ts";
import type { CounterStore } from "./organizer-cancel.ts";

export interface RunDeps {
  runtime: Runtime;
  storage: StorageAdapter;
  messenger: Messenger;
  familyId: string;
  source: FeeSource;
  counters?: CounterStore;
  notifier?: Notifier;
  client?: TelegramClient;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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

async function editCancelled(deps: RunDeps, failures: string[]): Promise<void> {
  if (!deps.client) return;
  try {
    await editCancelledMessages({ storage: deps.storage, familyId: deps.familyId, client: deps.client, log: (m) => deps.runtime.log("warn", m) });
  } catch (error) {
    failures.push(`cancel edit: ${messageOf(error)}`);
  }
}

function reportFailures(runtime: Runtime, failures: readonly string[]): string[] {
  for (const failure of failures) {
    runtime.log(isFetchCapError(failure) ? "warn" : "error", isFetchCapError(failure) ? `fetch cap: ${failure}` : failure);
  }
  return failures.filter((failure) => !isFetchCapError(failure));
}

export async function runPaymentsWatch(deps: RunDeps): Promise<string[]> {
  const { runtime, storage, familyId } = deps;
  const failures: string[] = [];
  try {
    await runPayments({ familyId, storage, source: deps.source, now: runtime.now(), counters: deps.counters });
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
