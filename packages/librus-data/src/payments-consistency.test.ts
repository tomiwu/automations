import { describe, expect, it } from "vitest";
import { comparePaymentsProjection, projectionRows, type PaymentHead, type ProjectionRow } from "./payments-consistency.ts";
import type { Payment } from "./storage.ts";

const STREAM = "payment:c1:f1:2026-12";
const row: ProjectionRow = {
  id: "p1",
  stream: STREAM,
  status: "pending",
  amount: 15050,
  amountSource: "config",
  notifiedAt: "2026-12-10T08:00:00.000Z",
  remindedAt: null,
};
const head: PaymentHead = {
  stream: STREAM,
  payload: { status: "pending", amount: 15050, amountSource: "config", notifiedAt: "2026-12-10T08:00:00.000Z", remindedAt: null, organizer: "X" },
};

describe("comparePaymentsProjection", () => {
  it("gives no difference when the head and the row match", () => {
    expect(comparePaymentsProjection([head], [row])).toEqual([]);
  });

  it("names each field that is different, and no values", () => {
    const changed = { ...row, status: "paid", remindedAt: "2026-12-14T08:00:00.000Z" };
    expect(comparePaymentsProjection([head], [changed])).toEqual([
      { stream: STREAM, paymentId: "p1", problem: "mismatch", field: "status" },
      { stream: STREAM, paymentId: "p1", problem: "mismatch", field: "remindedAt" },
    ]);
  });

  it("reads a field that is not in the payload as null", () => {
    const { remindedAt: _gone, ...payload } = head.payload;
    expect(comparePaymentsProjection([{ stream: STREAM, payload }], [row])).toEqual([]);
  });

  it("finds a row without a head and a head without a row, and ignores other streams", () => {
    const other: PaymentHead = { stream: "payment:c1:f1:2026-11", payload: {} };
    const lesson: PaymentHead = { stream: "lesson:c1:x", payload: {} };
    expect(comparePaymentsProjection([other, lesson], [row])).toEqual([
      { stream: STREAM, paymentId: "p1", problem: "missing_head" },
      { stream: other.stream, paymentId: null, problem: "missing_row" },
    ]);
  });
});

describe("projectionRows", () => {
  const payment: Payment = {
    id: "p1",
    familyId: "fam",
    feeId: "f1",
    month: "2026-12",
    amount: 15050,
    amountSource: "config",
    status: "pending",
    notifiedAt: new Date("2026-12-10T08:00:00Z"),
    remindedAt: null,
    decidedAt: null,
    decidedBy: null,
    refundCheckAt: null,
    createdAt: new Date("2026-12-10T08:00:00Z"),
  };

  it("makes the stream from the Child of the Fee and the dates as ISO text", () => {
    expect(projectionRows([payment], [{ id: "f1", childId: "c1" }])).toEqual([row]);
  });

  it("leaves out a Payment of an unknown Fee", () => {
    expect(projectionRows([payment], [])).toEqual([]);
  });
});
