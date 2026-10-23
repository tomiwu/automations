import type { Fee, Payment, StorageAdapter } from "@automations/librus-data";
import { localDate, t, type Child, type Config, type MessageKey, type Recipient } from "@automations/shared";
import type { FeeSource } from "./fee-source.ts";

/** What one run of the Payment engine needs. */
export interface PaymentRun {
  familyId: string;
  storage: StorageAdapter;
  source: FeeSource;
  now: Date;
}

interface RunContext {
  storage: StorageAdapter;
  config: Config;
  day: number;
  month: string;
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** Formats grosze as a decimal amount, for example 15050 gives "150.50". */
export function formatAmount(grosze: number): string {
  return `${Math.trunc(grosze / 100)}.${pad(grosze % 100)}`;
}

function notificationText(recipient: Recipient, kind: MessageKey, child: Child, fee: Fee, payment: Payment): string {
  return t(recipient.language, kind, {
    child: child.name,
    organizer: fee.organizer,
    month: payment.month,
    amount: formatAmount(payment.amount),
    date: `${payment.month}-${pad(fee.dueDay)}`,
  });
}

async function queue(context: RunContext, fee: Fee, payment: Payment, kind: "payment.new" | "payment.reminder"): Promise<void> {
  const child = context.config.children.find((candidate) => candidate.id === fee.childId);
  if (!child) return;
  const suffix = kind === "payment.reminder" ? ":reminder" : "";
  for (const recipient of context.config.recipients.filter((r) => r.child_ids.includes(fee.childId))) {
    await context.storage.enqueueNotification({
      key: `payment:${payment.id}:${recipient.telegram_chat_id}${suffix}`,
      familyId: payment.familyId,
      chatId: recipient.telegram_chat_id,
      text: notificationText(recipient, kind, child, fee, payment),
    });
  }
}

function isDue(context: RunContext, fee: Fee): boolean {
  return fee.enabled && context.day >= fee.notifyDay;
}

async function notifyPayment(context: RunContext, fee: Fee, payment: Payment): Promise<void> {
  if (payment.status !== "pending") return;
  await queue(context, fee, payment, "payment.new");
  if (context.day >= fee.reminderDay) await queue(context, fee, payment, "payment.reminder");
}

async function handleFee(context: RunContext, source: FeeSource, fee: Fee): Promise<void> {
  if (!isDue(context, fee)) return;
  const found = await source.amountFor(fee, context.month);
  if (!found || found.amount <= 0) return;
  const payment = await context.storage.upsertPayment({
    familyId: fee.familyId,
    feeId: fee.id,
    month: context.month,
    amount: found.amount,
    amountSource: found.source,
  });
  await notifyPayment(context, fee, payment);
}

/**
 * Makes the Payments of the current month (in the Family time zone) and queues their Notifications.
 * A Payment is made on `notifyDay` or later, one time only. A `pending` Payment gets one Notification
 * for each Recipient of the Child, and one reminder on `reminderDay` or later. The Outbox keys make a
 * repeated run send nothing twice. A `paid` or `skipped` Payment gets nothing.
 */
export async function runPayments(run: PaymentRun): Promise<void> {
  const config = await run.storage.loadConfig(run.familyId);
  const today = localDate(run.now, config.family.timezone);
  const context: RunContext = {
    storage: run.storage,
    config,
    day: Number(today.slice(8)),
    month: today.slice(0, 7),
  };
  for (const fee of await run.storage.listFees(run.familyId)) await handleFee(context, run.source, fee);
}
