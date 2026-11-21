import { createTelegramNotifier } from "../notifier.ts";
import { createPaymentFeeSource } from "../activenow-fee-source.ts";
import { runPaymentsWatch } from "../run.ts";
import { entryDeps, telegramClient, telegramMessenger } from "./common.ts";

/**
 * Runs one scheduled pass: the Payment engine and the delivery of the Outbox. It reads the config from
 * Supabase. It takes no input. With `paymentPhotos: true` in the deployment config, the Payment Notifications and
 * reminders go out as QR photos with Paid and Skip; else as text.
 * It rejects when the engine or the delivery failed.
 */
export default async function scheduled(input: unknown = {}): Promise<{ ok: true }> {
  if (typeof input !== "object" || input === null || Object.keys(input).length > 0) {
    throw new Error("This export takes no input.");
  }
  const deps = await entryDeps();
  const source = createPaymentFeeSource({ ...deps, ledgerStore: deps.counters! });
  const notifier = deps.paymentPhotos ? createTelegramNotifier(telegramClient) : undefined;
  const failures = await runPaymentsWatch({ ...deps, messenger: telegramMessenger, source, notifier, client: deps.paymentPhotos ? telegramClient : undefined });
  if (failures.length > 0) throw new Error(failures.join("; "));
  return { ok: true };
}
