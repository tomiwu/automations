import type { StorageAdapter } from "@automations/librus-data";
import { formatFetchCount, type FetchCounter, type Runtime } from "@automations/shared";

/** Outbox entries that were delivered more than this number of days ago are removed. */
export const PURGE_AFTER_DAYS = 30;

export interface PurgeDeps {
  storage: StorageAdapter;
  runtime: Runtime;
  counter?: FetchCounter;
}

/** Removes the old delivered Outbox entries. Returns the number removed. */
export async function runPurge(deps: PurgeDeps): Promise<number> {
  const removed = await deps.storage.purgeDelivered(PURGE_AFTER_DAYS);
  deps.runtime.log("info", `purged ${removed} delivered Outbox entries`);
  if (deps.counter) deps.runtime.log("info", formatFetchCount(deps.counter.count()));
  return removed;
}
