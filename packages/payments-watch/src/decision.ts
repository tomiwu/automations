import { paymentStream, planPaymentDecision, planPaymentDue } from "@automations/librus-data";
import type { Fee, JournalEvent, NewJournalEvent, Payment, PaymentDecision, StorageAdapter } from "@automations/librus-data";

export interface DecisionInput {
  storage: StorageAdapter;
  familyId: string;
  payment: Payment;
  fee: Fee;
  decision: PaymentDecision;
  decidedBy: string;
  at: Date;
}

/** The head to decide on, and the `PaymentDue` to append before it when the Payment has no head (made before the Journal). */
async function headOf(input: DecisionInput): Promise<{ head?: JournalEvent; due: NewJournalEvent | null }> {
  const { storage, familyId, payment, fee, at } = input;
  const stream = paymentStream(fee.childId, fee.id, payment.month);
  const [stored] = await storage.listHeads(familyId, { kinds: ["payment"], streams: [stream] });
  if (stored) return { head: stored, due: null };
  const due = await planPaymentDue(undefined, fee, payment);
  return { head: due ? { ...due, recordedAt: at } : undefined, due };
}

async function planEvents(input: DecisionInput): Promise<NewJournalEvent[]> {
  const { head, due } = await headOf(input);
  const event = head && (await planPaymentDecision(head, input.decision, input.decidedBy, input.at));
  return event ? [...(due ? [due] : []), event] : [];
}

async function append(storage: StorageAdapter, events: NewJournalEvent[]): Promise<boolean> {
  try {
    await storage.appendEvents(events);
    return true;
  } catch {
    return false;
  }
}

/**
 * The steps of a Paid or Skip press, for the Telegram callback and the Dashboard. It appends the decision event
 * (with `PaymentDue` before it, in the same call, when the Payment has no head), then sets the projection.
 * Returns false when nothing changed: the Payment is decided already, or the append failed (for example a `seq` conflict).
 */
export async function decidePayment(input: DecisionInput): Promise<boolean> {
  const { storage, payment, decision, decidedBy } = input;
  const events = payment.status === "pending" ? await planEvents(input) : [];
  if (events.length === 0 || !(await append(storage, events))) return false;
  return storage.setPaymentStatus(payment.id, decision, decidedBy);
}
