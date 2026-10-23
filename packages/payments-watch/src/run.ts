import type { StorageAdapter } from "@automations/librus-data";
import type { Runtime } from "@automations/shared";
import { deliverPending, type Messenger } from "@tomiwu/librus-watch";
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
 * Runs one scheduled pass: the Payment engine, then the delivery of the Outbox to the Recipients.
 * Returns the failure texts. The caller rejects when the list is not empty.
 */
export async function runPaymentsWatch(deps: RunDeps): Promise<string[]> {
  const { runtime, storage, familyId } = deps;
  const failures: string[] = [];
  try {
    await runPayments({ familyId, storage, source: deps.source, now: runtime.now() });
  } catch (error) {
    failures.push(`payments: ${messageOf(error)}`);
  }
  try {
    const config = await storage.loadConfig(familyId);
    await deliverPending({
      storage,
      familyId,
      messenger: deps.messenger,
      chatIds: config.recipients.map((recipient) => recipient.telegram_chat_id),
      log: (message) => runtime.log("info", message),
    });
  } catch (error) {
    failures.push(`deliver: ${messageOf(error)}`);
  }
  for (const failure of failures) runtime.log("error", failure);
  return failures;
}
