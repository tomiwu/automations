import {
  checkCompletedForPayments,
  paymentStream,
  planPaymentCancelled,
  planPaymentDue,
  planPaymentReappeared,
  type Fee,
  type JournalEvent,
  type NewJournalEvent,
  type Payment,
  type StorageAdapter,
} from "@automations/librus-data";
import { localDate, t, type Child, type Config, type MessageKey, type Recipient } from "@automations/shared";
import type { FeeAmount, FeeSource } from "./fee-source.ts";
import { advanceCounters, loadCounters, saveCounters, type CancelDue, type CounterStep, type CounterStore, type Watched } from "./organizer-cancel.ts";

export interface PaymentRun {
  familyId: string;
  storage: StorageAdapter;
  source: FeeSource;
  now: Date;
  /** Where the counters of the Organizer cancel are kept. Without it, no Payment is cancelled for an Organizer page. */
  counters?: CounterStore;
}

interface RunContext {
  storage: StorageAdapter;
  config: Config;
  day: number;
  month: string;
  heads: ReadonlyMap<string, JournalEvent>;
  events: NewJournalEvent[];
  payments: readonly Payment[];
  watched: Watched[];
  now: Date;
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

const dateOf = (value: unknown): Date | null => (typeof value === "string" ? new Date(value) : null);

function journalState(stored: Payment, found: FeeAmount, head: JournalEvent | undefined): Payment {
  return {
    ...stored,
    amount: found.amount,
    amountSource: found.source,
    notifiedAt: dateOf(head?.payload.notifiedAt) ?? stored.notifiedAt,
    remindedAt: dateOf(head?.payload.remindedAt) ?? stored.remindedAt,
  };
}

async function journalPayment(context: RunContext, fee: Fee, stored: Payment, found: FeeAmount): Promise<Payment> {
  if (stored.status !== "pending") return stored;
  const head = context.heads.get(paymentStream(fee.childId, fee.id, stored.month));
  const next = journalState(stored, found, head);
  const event = await planPaymentDue(head, fee, next);
  if (event) context.events.push(event);
  if (next.amount === stored.amount && next.amountSource === stored.amountSource) return stored;
  await context.storage.updatePendingAmount(stored.id, next.amount, next.amountSource);
  return { ...stored, amount: next.amount, amountSource: next.amountSource };
}

async function cancelBase(context: RunContext, fee: Fee, payment: Payment): Promise<JournalEvent | undefined> {
  const head = context.heads.get(paymentStream(fee.childId, fee.id, payment.month));
  if (head) return head;
  const due = await planPaymentDue(undefined, fee, payment);
  if (due) context.events.push(due);
  return due ? { ...due, recordedAt: context.now } : undefined;
}

async function cancelDisabled(context: RunContext, fee: Fee): Promise<void> {
  const payment = context.payments.find((p) => p.feeId === fee.id && p.month === context.month && p.status === "pending");
  if (!payment) return;
  const base = await cancelBase(context, fee, payment);
  const event = base && (await planPaymentCancelled(base, "fee_disabled", context.now));
  if (!event) return;
  context.events.push(event);
  await context.storage.cancelPendingPayment(payment.id);
}

function watch(context: RunContext, source: FeeSource, fee: Fee): void {
  const observation = source.observationFor?.(fee, context.month);
  const payment = context.payments.find((p) => p.feeId === fee.id && p.month === context.month);
  if (observation && payment) context.watched.push({ fee, payment, observation });
}

async function latestBase(context: RunContext, fee: Fee, payment: Payment): Promise<JournalEvent | undefined> {
  const stream = paymentStream(fee.childId, fee.id, payment.month);
  const planned = context.events.findLast((event) => event.stream === stream);
  return planned ? { ...planned, recordedAt: context.now } : cancelBase(context, fee, payment);
}

async function cancelOrganizer(context: RunContext, { watched, reason, evidence }: CancelDue): Promise<void> {
  const { fee, payment } = watched;
  const base = await latestBase(context, fee, payment);
  const event = base && (await planPaymentCancelled(base, reason, context.now, evidence));
  if (!event) return;
  context.events.push(event);
  await context.storage.cancelPendingPayment(payment.id);
}

async function flagRefund(context: RunContext, { watched }: CancelDue): Promise<void> {
  const { fee, payment } = watched;
  if (!(await context.storage.flagRefundCheck(payment.id, context.now))) return;
  const child = context.config.children.find((candidate) => candidate.id === fee.childId);
  for (const recipient of context.config.recipients.filter((r) => r.child_ids.includes(fee.childId))) {
    await context.storage.enqueueNotification({
      key: `refund-check:${payment.id}:${recipient.telegram_chat_id}`,
      familyId: payment.familyId,
      chatId: recipient.telegram_chat_id,
      text: t(recipient.language, "payment.refund_check.notice", { child: child?.name ?? "", organizer: fee.organizer, month: payment.month }),
    });
  }
}

async function reappear(context: RunContext, { fee, payment }: Watched): Promise<void> {
  const head = context.heads.get(paymentStream(fee.childId, fee.id, payment.month));
  const event = head && (await planPaymentReappeared(head));
  if (!event) return;
  context.events.push(event);
  await context.storage.reopenCancelledPayment(payment.id);
}

async function actOnDue(context: RunContext, item: CancelDue): Promise<void> {
  if (item.watched.payment.status === "paid") await flagRefund(context, item);
  else await cancelOrganizer(context, item);
}

async function planOrganizer(context: RunContext, step: CounterStep): Promise<void> {
  for (const item of step.due) await actOnDue(context, item);
  for (const item of step.listed) await reappear(context, item);
}

const nothing = async (): Promise<void> => undefined;

async function applyOrganizer(context: RunContext, store: CounterStore | undefined): Promise<() => Promise<void>> {
  if (!store || context.watched.length === 0) return nothing;
  const stored = await loadCounters(store);
  const step = advanceCounters(stored, context.watched, context.month);
  await planOrganizer(context, step);
  return JSON.stringify(step.counters) === JSON.stringify(stored) ? nothing : async () => void (await saveCounters(store, step.counters));
}

async function handleFee(context: RunContext, source: FeeSource, fee: Fee): Promise<void> {
  if (!fee.enabled) return cancelDisabled(context, fee);
  if (!isDue(context, fee)) return;
  const found = await source.amountFor(fee, context.month);
  watch(context, source, fee);
  if (!found || found.amount <= 0) return;
  const stored = await context.storage.upsertPayment({
    familyId: fee.familyId,
    feeId: fee.id,
    month: context.month,
    amount: found.amount,
    amountSource: found.source,
  });
  await notifyPayment(context, fee, await journalPayment(context, fee, stored, found));
}

const checkStream = (childId: string): string => `check:payments-watch:${childId}`;

async function checkEvents(run: PaymentRun, fees: readonly Fee[]): Promise<NewJournalEvent[]> {
  const childIds = [...new Set(fees.filter((fee) => fee.enabled).map((fee) => fee.childId))];
  if (childIds.length === 0) return [];
  const heads = await run.storage.listHeads(run.familyId, { streams: childIds.map(checkStream) });
  return Promise.all(
    childIds.map((childId) =>
      checkCompletedForPayments(run.familyId, childId, run.now, heads.find((head) => head.stream === checkStream(childId))),
    ),
  );
}

async function handleFees(context: RunContext, run: PaymentRun, fees: readonly Fee[]): Promise<void> {
  let failed = true;
  let persist = nothing;
  try {
    for (const fee of fees) await handleFee(context, run.source, fee);
    persist = await applyOrganizer(context, run.counters);
    failed = false;
  } finally {
    const checks = failed ? [] : await checkEvents(run, fees);
    const events = [...context.events, ...checks];
    if (events.length > 0) await run.storage.appendEvents(events);
  }
  await persist();
}

/**
 * Makes the Payments of the current month (in the Family time zone) and queues their Notifications.
 * A Payment is made on `notifyDay` or later, one time only. A `pending` Payment gets one Notification
 * for each Recipient of the Child, and one reminder on `reminderDay` or later. The Outbox keys make a
 * repeated run send nothing twice. A `paid`, `skipped` or `cancelled` Payment gets nothing. A disabled Fee with a
 * pending Payment in the current month gets `PaymentCancelled` (`fee_disabled`) and the status `cancelled`. An Organizer
 * page that lists the charge as void, or does not list it, or shows the Child as withdrawn, gives a candidate cancel.
 * After `CANCEL_AFTER` successful passes in a row with the same candidate, the pending Payment gets `PaymentCancelled`
 * (`organizer_void` or `organizer_withdrawn`). A paid Payment with the same candidate gets only the refund-check flag and one notice for each Recipient (no event, the status stays `paid`). A listed charge resets the count, and brings back a cancelled Payment with `PaymentDue`.
 * The pass also writes the Journal: `PaymentDue` or `PaymentChanged` for a pending Payment, and one
 * `CheckCompleted` for each Child with an enabled Fee when the pass did not fail. All events go in one append.
 */
export async function runPayments(run: PaymentRun): Promise<void> {
  const config = await run.storage.loadConfig(run.familyId);
  const today = localDate(run.now, config.family.timezone);
  const fees = await run.storage.listFees(run.familyId);
  const heads = await run.storage.listHeads(run.familyId, { kinds: ["payment"] });
  const context: RunContext = {
    storage: run.storage,
    config,
    day: Number(today.slice(8)),
    month: today.slice(0, 7),
    heads: new Map(heads.map((head) => [head.stream, head])),
    events: [],
    payments: fees.some((fee) => !fee.enabled || (run.counters && fee.sourceUrl)) ? await run.storage.listPayments(run.familyId) : [],
    watched: [],
    now: run.now,
  };
  await handleFees(context, run, fees);
}
