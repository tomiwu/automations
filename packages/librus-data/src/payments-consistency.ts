import { paymentStream } from "./payment-journal.ts";
import type { Fee, Payment } from "./storage.ts";

/** One row of the `payments` table, with the Child of its Fee, in the shape that the Journal payload has. */
export interface ProjectionRow {
  id: string;
  stream: string;
  status: string;
  amount: number;
  amountSource: string;
  notifiedAt: string | null;
  remindedAt: string | null;
}

/** The head of one `payment:` stream: the last event and its full-state payload. */
export interface PaymentHead {
  stream: string;
  payload: Record<string, unknown>;
}

/** One difference between the Journal and the `payments` table. It names fields, never values. */
export interface PaymentDifference {
  stream: string;
  paymentId: string | null;
  problem: "missing_head" | "missing_row" | "mismatch";
  field?: string;
}

/** The compared fields: the Journal payload key and the row key have the same name. */
export const COMPARED_FIELDS = ["status", "amount", "amountSource", "notifiedAt", "remindedAt"] as const;

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

/** The rows of the `payments` table as `ProjectionRow`s. A Payment of an unknown Fee is left out. */
export function projectionRows(payments: readonly Payment[], fees: readonly Pick<Fee, "id" | "childId">[]): ProjectionRow[] {
  const childOf = new Map(fees.map((fee) => [fee.id, fee.childId]));
  return payments.flatMap((payment) => {
    const childId = childOf.get(payment.feeId);
    if (childId === undefined) return [];
    return [{
      id: payment.id,
      stream: paymentStream(childId, payment.feeId, payment.month),
      status: payment.status,
      amount: payment.amount,
      amountSource: payment.amountSource,
      notifiedAt: iso(payment.notifiedAt),
      remindedAt: iso(payment.remindedAt),
    }];
  });
}

function fieldDifferences(row: ProjectionRow, head: PaymentHead): PaymentDifference[] {
  return COMPARED_FIELDS.filter((field) => (head.payload[field] ?? null) !== row[field]).map((field) => ({
    stream: row.stream,
    paymentId: row.id,
    problem: "mismatch",
    field,
  }));
}

/**
 * Compares the Journal heads of the `payment:` streams with the `payments` table (the dual write of
 * payments contract section 7). An empty list means both writes match.
 */
export function comparePaymentsProjection(heads: readonly PaymentHead[], rows: readonly ProjectionRow[]): PaymentDifference[] {
  const headOf = new Map(heads.filter((head) => head.stream.startsWith("payment:")).map((head) => [head.stream, head]));
  const differences: PaymentDifference[] = [];
  for (const row of rows) {
    const head = headOf.get(row.stream);
    headOf.delete(row.stream);
    if (head === undefined) differences.push({ stream: row.stream, paymentId: row.id, problem: "missing_head" });
    else differences.push(...fieldDifferences(row, head));
  }
  for (const stream of headOf.keys()) differences.push({ stream, paymentId: null, problem: "missing_row" });
  return differences;
}
