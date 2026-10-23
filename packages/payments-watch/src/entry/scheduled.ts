import { createWebFeeSource } from "../page-source.ts";
import { runPaymentsWatch } from "../run.ts";
import { entryDeps, telegramMessenger } from "./common.ts";

/**
 * Runs one scheduled pass: the Payment engine and the delivery of the Outbox. It reads the config from
 * Supabase. It takes no input.
 * It rejects when the engine or the delivery failed.
 */
export default async function scheduled(input: unknown = {}): Promise<{ ok: true }> {
  if (typeof input !== "object" || input === null || Object.keys(input).length > 0) {
    throw new Error("This export takes no input.");
  }
  const deps = await entryDeps();
  const source = createWebFeeSource(deps);
  const failures = await runPaymentsWatch({ ...deps, messenger: telegramMessenger, source });
  if (failures.length > 0) throw new Error(failures.join("; "));
  return { ok: true };
}
