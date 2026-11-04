import type { FetchCount } from "@automations/shared";
import { runLibrusWatch } from "../run.ts";
import { entryDeps, telegramMessenger } from "./common.ts";

/**
 * Runs one scheduled pass: the Watchers of each Librus Account, the Morning report on report runs, and the
 * delivery of the Outbox. It reads the config from Supabase. It takes no input.
 * It rejects when a Watcher, an Account or the delivery failed.
 */
export default async function scheduled(input: unknown = {}): Promise<{ ok: true; fetches: FetchCount }> {
  if (typeof input !== "object" || input === null || Object.keys(input).length > 0) {
    throw new Error("This export takes no input.");
  }
  const deps = await entryDeps();
  const failures = await runLibrusWatch({ ...deps, messenger: telegramMessenger });
  if (failures.length > 0) throw new Error(failures.join("; "));
  return { ok: true, fetches: deps.counter.count() };
}
