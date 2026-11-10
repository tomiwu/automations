/**
 * Delivers the Payment Notifications of the Outbox (keys `payment:<id>:<chat>` and `payment:<id>:<chat>:reminder`)
 * through the Notifier: a QR photo with a caption and the buttons Paid and Skip. The reminder uses the same path,
 * and its caption starts with the reminder marker. The QR is built at send time from the Fee and the current
 * amount of the Payment. It is never read from the Journal or from `./stored-payments`.
 */
import type { Fee, OutboxEntry, Payment, StorageAdapter } from "@automations/librus-data";
import type { Child, Config, Recipient } from "@automations/shared";
import type { Notifier } from "./notifier.ts";
import { PAYMENT_KEY } from "./sent-journal.ts";
import { buildZbpQr } from "./zbp.ts";

export interface PaymentDeliveryDeps {
  storage: StorageAdapter;
  familyId: string;
  notifier: Notifier;
  log?: (message: string) => void;
}

/** True for an Outbox key of a Payment Notification. */
export const isPaymentKey = (key: string): boolean => PAYMENT_KEY.test(key);

interface Target {
  entry: OutboxEntry;
  reminder: boolean;
  payment?: Payment;
  fee?: Fee;
  child?: Child;
  recipient?: Recipient;
}

interface Lookup {
  config: Config;
  payments: Map<string, Payment>;
  fees: Map<string, Fee>;
}

function targetOf(entry: OutboxEntry, lookup: Lookup): Target {
  const [, id = "", reminder] = PAYMENT_KEY.exec(entry.key) ?? [];
  const payment = lookup.payments.get(id);
  const fee = payment && lookup.fees.get(payment.feeId);
  const child = fee && lookup.config.children.find((candidate) => candidate.id === fee.childId);
  const recipient = lookup.config.recipients.find((candidate) => candidate.telegram_chat_id === entry.chatId);
  return { entry, reminder: Boolean(reminder), payment, fee, child, recipient };
}

/** Why an entry is not sent: no data, a decided Payment, or a Notification that went out already. */
function isComplete(target: Target): target is Required<Target> {
  return Boolean(target.payment && target.fee && target.child && target.recipient);
}

function sentAlready(target: Required<Target>): string | undefined {
  const at = target.reminder ? target.payment.remindedAt : target.payment.notifiedAt;
  if (!at) return undefined;
  return target.reminder ? "reminder sent already" : "notification sent already";
}

function dropReason(target: Target): string | undefined {
  if (!isComplete(target)) return "unknown payment, fee, child or recipient";
  if (target.payment.status !== "pending") return `payment is ${target.payment.status}`;
  return sentAlready(target);
}

async function send(deps: PaymentDeliveryDeps, target: Required<Target>): Promise<void> {
  const { fee, payment } = target;
  const qr = await buildZbpQr({ nip: fee.nip ?? "", nrb: fee.account, amountGrosze: payment.amount, recipient: fee.recipientName, title: fee.title });
  await deps.notifier.sendPayment(target.recipient, { child: target.child, fee, payment, reminder: target.reminder }, qr);
}

interface PhotoRun {
  sent: string[];
  dropped: string[];
  failures: unknown[];
  blocked: Set<string>;
}

async function tryTarget(deps: PaymentDeliveryDeps, target: Target, run: PhotoRun): Promise<void> {
  const reason = dropReason(target);
  if (reason) {
    deps.log?.(`payment photo: skip ${target.entry.key.split(":")[1]} (${reason})`);
    run.dropped.push(target.entry.key);
    return;
  }
  try {
    await send(deps, target as Required<Target>);
    run.sent.push(target.entry.key);
  } catch (error) {
    run.blocked.add(target.entry.chatId);
    run.failures.push(error);
  }
}

async function lookupOf(deps: PaymentDeliveryDeps): Promise<Lookup> {
  const [config, payments, fees] = await Promise.all([
    deps.storage.loadConfig(deps.familyId),
    deps.storage.listPayments(deps.familyId),
    deps.storage.listFees(deps.familyId),
  ]);
  return { config, payments: new Map(payments.map((p) => [p.id, p])), fees: new Map(fees.map((f) => [f.id, f])) };
}

/**
 * Sends each queued Payment Notification as a QR photo. A decided Payment, or a Notification whose time is set
 * already, is not sent: its entry is marked delivered. A failed send holds back its chat and keeps the entry.
 * Returns the keys that were sent (for `recordSent`) and the first failure, after all chats are tried.
 */
export async function deliverPaymentPhotos(deps: PaymentDeliveryDeps): Promise<{ sent: string[]; failure?: unknown }> {
  const queue = (await deps.storage.pendingNotifications(deps.familyId)).filter((entry) => isPaymentKey(entry.key));
  if (queue.length === 0) return { sent: [] };
  const lookup = await lookupOf(deps);
  const run: PhotoRun = { sent: [], dropped: [], failures: [], blocked: new Set() };
  try {
    for (const entry of queue) {
      if (!run.blocked.has(entry.chatId)) await tryTarget(deps, targetOf(entry, lookup), run);
    }
  } finally {
    await deps.storage.markDeliveredMany([...run.sent, ...run.dropped]);
  }
  deps.log?.(`payment photos: queued=${queue.length} sent=${run.sent.length} skipped=${run.dropped.length} failed=${run.failures.length}`);
  return run.failures.length > 0 ? { sent: run.sent, failure: run.failures[0] } : { sent: run.sent };
}

/** The storage for the text delivery: it does not see the Payment entries, so they are never sent as text. */
export function withoutPaymentEntries(storage: StorageAdapter): StorageAdapter {
  return {
    ...storage,
    pendingNotifications: async (familyId) => (await storage.pendingNotifications(familyId)).filter((entry) => !isPaymentKey(entry.key)),
  };
}
