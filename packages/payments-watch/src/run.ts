import type { StorageAdapter } from "@automations/librus-data";
import { isFetchCapError, type Runtime } from "@automations/shared";
import { deliverPending, type Messenger } from "@tomiwu/librus-watch";
import { recordSent } from "./sent-journal.ts";
import { runPayments } from "./engine.ts";
import type { FeeSource } from "./fee-source.ts";

export interface RunDeps {
  runtime: Runtime;
  storage: StorageAdapter;
  messenger: Messenger;
  familyId: string;
  source: FeeSource;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

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
    await runPayments({ familyId, storage, source: deps.source, now: runtime.now() });
  } catch (error) {
    failures.push(`payments: ${messageOf(error)}`);
  }
  const delivered: string[] = [];
  const watching: StorageAdapter = {
    ...storage,
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
