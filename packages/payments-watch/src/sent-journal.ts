import { paymentStream, planPaymentSent } from "@automations/librus-data";
import type { NewJournalEvent, PaymentSent, StorageAdapter } from "@automations/librus-data";

const PAYMENT_KEY = /^payment:([^:]+):[^:]+(:reminder)?$/;

/** Which Payments got a first Notification or a reminder, from the Outbox keys that were delivered. */
export function sentOfKeys(keys: readonly string[]): Map<string, PaymentSent[]> {
  const sent = new Map<string, Set<PaymentSent>>();
  for (const [, id, reminder] of keys.map((key) => PAYMENT_KEY.exec(key) ?? [])) {
    if (id) sent.set(id, (sent.get(id) ?? new Set()).add(reminder ? "reminded" : "notified"));
  }
  return new Map([...sent].map(([id, kinds]) => [id, [...kinds]]));
}

async function sentEvents(storage: StorageAdapter, familyId: string, sent: Map<string, PaymentSent[]>, at: Date) {
  const payments = (await storage.listPayments(familyId)).filter((payment) => sent.has(payment.id));
  const fees = new Map((await storage.listFees(familyId)).map((fee) => [fee.id, fee]));
  const heads = await storage.listHeads(familyId, { kinds: ["payment"] });
  const planned: { id: string; event: NewJournalEvent; which: PaymentSent[] }[] = [];
  for (const payment of payments) {
    const fee = fees.get(payment.feeId);
    const head = heads.find((other) => fee && other.stream === paymentStream(fee.childId, fee.id, payment.month));
    const which = sent.get(payment.id) ?? [];
    const event = head ? await planPaymentSent(head, which, at) : null;
    if (event) planned.push({ id: payment.id, event, which });
  }
  return planned;
}

async function markProjection(storage: StorageAdapter, planned: readonly { id: string; which: PaymentSent[] }[], at: Date) {
  for (const { id, which } of planned) for (const kind of which) await storage.markPaymentSent(id, kind, at);
}

/** Appends the events. A failed append (for example a `seq` conflict) gives false and changes nothing. */
async function appended(storage: StorageAdapter, events: NewJournalEvent[]): Promise<boolean> {
  try {
    await storage.appendEvents(events);
    return true;
  } catch {
    return false;
  }
}

/**
 * After a delivery: appends one `PaymentChanged` for each pending Payment that got its first Notification or its
 * reminder, with `notifiedAt` or `remindedAt` set, then sets the same times in the projection. The journal holds no
 * QR text and no bank data. A failed append (for example a `seq` conflict) changes nothing. Returns the event count.
 */
export async function recordSent(storage: StorageAdapter, familyId: string, keys: readonly string[], at: Date): Promise<number> {
  const sent = sentOfKeys(keys);
  const planned = sent.size === 0 ? [] : await sentEvents(storage, familyId, sent, at);
  if (planned.length === 0 || !(await appended(storage, planned.map((item) => item.event)))) return 0;
  await markProjection(storage, planned, at);
  return planned.length;
}
