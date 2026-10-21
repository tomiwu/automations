import { runActivitiesWatch } from "../run.ts";
import { entryDeps, telegramMessenger } from "./common.ts";

/**
 * Runs one scheduled pass: the Watcher of each ActiveNow and Edusky Account and the delivery of the
 * Outbox. It reads the config from Supabase. It takes no input.
 * It rejects when an Account or the delivery failed.
 */
export default async function scheduled(input: unknown = {}): Promise<{ ok: true }> {
  if (typeof input !== "object" || input === null || Object.keys(input).length > 0) {
    throw new Error("This export takes no input.");
  }
  const failures = await runActivitiesWatch({ ...(await entryDeps()), messenger: telegramMessenger });
  if (failures.length > 0) throw new Error(failures.join("; "));
  return { ok: true };
}
