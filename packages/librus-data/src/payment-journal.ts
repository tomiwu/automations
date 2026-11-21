import { checkEvent, contentHash } from "./journal.ts";
import type { Fee, JournalEvent, NewJournalEvent, NewPayment, Payment } from "./storage.ts";

const SOURCE = "payments-watch";

export type PaymentInput = NewPayment & Partial<Pick<Payment, "status" | "notifiedAt" | "remindedAt" | "decidedAt" | "decidedBy">>;

export type PaymentDecision = "paid" | "skipped";

export type PaymentCancelReason = "fee_disabled" | "organizer_void" | "organizer_withdrawn";

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

/**
 * `PaymentCancelled` for a pending head (payments contract v0.2 section 3b). The payload is the full state:
 * the head payload with `status: "cancelled"`, `cancelReason`, `cancelledAt` and an optional `cancelEvidence`.
 * `decidedAt` and `decidedBy` stay: a cancel is not a human decision. Else null: paid, skipped and cancelled are final.
 */
export async function planPaymentCancelled(
  head: JournalEvent,
  reason: PaymentCancelReason,
  at: Date,
  evidence?: string,
): Promise<NewJournalEvent | null> {
  if (head.payload.status !== "pending") return null;
  const payload: Record<string, unknown> = { ...head.payload, status: "cancelled", cancelReason: reason, cancelledAt: at.toISOString() };
  if (evidence !== undefined) payload.cancelEvidence = evidence;
  return {
    familyId: head.familyId,
    childId: head.childId,
    stream: head.stream,
    seq: head.seq + 1,
    kind: "payment",
    day: head.day,
    eventType: "PaymentCancelled",
    payload,
    contentHash: await contentHash(payload),
    source: SOURCE,
  };
}

const CANCEL_FIELDS = ["cancelReason", "cancelledAt", "cancelEvidence"] as const;

/**
 * `PaymentDue` on the stream of a head that an Organizer cancelled, when the charge is listed again (payments contract
 * v0.2 section 3b, R1 to R3). The payload is the head payload with `status: "pending"` and no cancel fields.
 * Else null: only `organizer_void` and `organizer_withdrawn` can re-appear; a `fee_disabled` cancel stays.
 */
export async function planPaymentReappeared(head: JournalEvent): Promise<NewJournalEvent | null> {
  const reason = head.payload.cancelReason;
  if (head.payload.status !== "cancelled" || (reason !== "organizer_void" && reason !== "organizer_withdrawn")) return null;
  const payload: Record<string, unknown> = { ...head.payload, status: "pending" };
  for (const field of CANCEL_FIELDS) delete payload[field];
  return {
    familyId: head.familyId,
    childId: head.childId,
    stream: head.stream,
    seq: head.seq + 1,
    kind: "payment",
    day: head.day,
    eventType: "PaymentDue",
    payload,
    contentHash: await contentHash(payload),
    source: SOURCE,
  };
}

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
