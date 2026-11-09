import { checkEvent, contentHash } from "./journal.ts";
import type { Fee, JournalEvent, NewJournalEvent, NewPayment, Payment } from "./storage.ts";

const SOURCE = "payments-watch";

/** The state of one Payment. A new Payment has only the `NewPayment` fields. */
export type PaymentInput = NewPayment & Partial<Pick<Payment, "status" | "notifiedAt" | "remindedAt" | "decidedAt" | "decidedBy">>;

export type PaymentDecision = "paid" | "skipped";

/** The stream of the Payment of one Fee in one month (`YYYY-MM`). */
export const paymentStream = (childId: string, feeId: string, month: string): string =>
  `payment:${childId}:${feeId}:${month}`;

const iso = (date: Date | null | undefined): string | null => date?.toISOString() ?? null;

/**
 * The full state of a Payment for the Journal. It holds no bank account, NIP, transfer title,
 * recipient name or source URL: the Journal is not the place for these.
 */
export function paymentPayload(fee: Fee, payment: PaymentInput): Record<string, unknown> {
  return {
    status: payment.status ?? "pending",
    amount: payment.amount,
    amountSource: payment.amountSource,
    dueDay: fee.dueDay,
    organizer: fee.organizer,
    month: payment.month,
    feeId: fee.id,
    childId: fee.childId,
    familyId: payment.familyId,
    notifiedAt: iso(payment.notifiedAt),
    remindedAt: iso(payment.remindedAt),
    decidedAt: iso(payment.decidedAt),
    decidedBy: payment.decidedBy ?? null,
  };
}

const dayOf = (month: string, dueDay: number): string => `${month}-${String(dueDay).padStart(2, "0")}`;

/**
 * The event for a Payment that is due: `PaymentDue` if the stream is new, `PaymentChanged` if the head
 * is pending and the state is different. Else null. An amount of 0 or less gives null.
 */
export async function planPaymentDue(
  head: JournalEvent | undefined,
  fee: Fee,
  payment: PaymentInput,
): Promise<NewJournalEvent | null> {
  if (payment.amount <= 0 || (head && head.payload.status !== "pending")) return null;
  const payload = paymentPayload(fee, payment);
  const hash = await contentHash(payload);
  return head?.contentHash === hash ? null : dueEvent(head, fee, payment, { payload, hash });
}

function dueEvent(
  head: JournalEvent | undefined,
  fee: Fee,
  payment: PaymentInput,
  state: { payload: Record<string, unknown>; hash: string },
): NewJournalEvent {
  return {
    familyId: payment.familyId,
    childId: fee.childId,
    stream: paymentStream(fee.childId, fee.id, payment.month),
    seq: (head?.seq ?? 0) + 1,
    kind: "payment",
    day: dayOf(payment.month, fee.dueDay),
    eventType: head ? "PaymentChanged" : "PaymentDue",
    payload: state.payload,
    contentHash: state.hash,
    source: SOURCE,
  };
}

/** `PaymentPaid` or `PaymentSkipped` for a pending head. Else null: a decision is final. */
export async function planPaymentDecision(
  head: JournalEvent,
  decision: PaymentDecision,
  decidedBy: string,
  at: Date,
): Promise<NewJournalEvent | null> {
  if (head.payload.status !== "pending") return null;
  const payload = { ...head.payload, status: decision, decidedAt: at.toISOString(), decidedBy };
  return {
    familyId: head.familyId,
    childId: head.childId,
    stream: head.stream,
    seq: head.seq + 1,
    kind: "payment",
    day: head.day,
    eventType: decision === "paid" ? "PaymentPaid" : "PaymentSkipped",
    payload,
    contentHash: await contentHash(payload),
    source: SOURCE,
  };
}

/** The `CheckCompleted` event of one pass of `payments-watch`. There is one check stream for each Child. */
export function checkCompletedForPayments(
  familyId: string,
  childId: string,
  at: Date,
  head?: JournalEvent,
): Promise<NewJournalEvent> {
  const payload = { checkedAt: at.toISOString() };
  const stream = `check:${SOURCE}:${childId}`;
  return checkEvent({ familyId, childId, stream, source: SOURCE, day: at.toISOString().slice(0, 10), head, payload });
}

export type PaymentSent = "notified" | "reminded";

const SENT_FIELD = { notified: "notifiedAt", reminded: "remindedAt" } as const;

/**
 * `PaymentChanged` that sets `notifiedAt` or `remindedAt` on a pending head. The amount and the amount source stay
 * as they are. Else null: a decided Payment gets nothing, and a time that is set stays.
 */
export async function planPaymentSent(
  head: JournalEvent,
  sent: readonly PaymentSent[],
  at: Date,
): Promise<NewJournalEvent | null> {
  const fresh = sent.filter((which) => head.payload.status === "pending" && !head.payload[SENT_FIELD[which]]);
  if (fresh.length === 0) return null;
  const payload = { ...head.payload, ...Object.fromEntries(fresh.map((which) => [SENT_FIELD[which], at.toISOString()])) };
  return {
    familyId: head.familyId,
    childId: head.childId,
    stream: head.stream,
    seq: head.seq + 1,
    kind: "payment",
    day: head.day,
    eventType: "PaymentChanged",
    payload,
    contentHash: await contentHash(payload),
    source: SOURCE,
  };
}
