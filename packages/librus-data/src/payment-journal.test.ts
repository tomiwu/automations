import { describe, expect, it } from "vitest";
import { contentHash } from "./journal.ts";
import {
  checkCompletedForPayments,
  paymentPayload,
  paymentStream,
  planPaymentDecision,
  planPaymentDue,
} from "./payment-journal.ts";
import type { PaymentInput } from "./payment-journal.ts";
import { CHILD_ID, FAMILY_ID, FEE_ID, exampleFee } from "./fixtures.ts";
import type { JournalEvent } from "./storage.ts";

const fee = exampleFee();
const AT = new Date("2025-01-12T08:00:00Z");

const payment = (overrides: Partial<PaymentInput> = {}): PaymentInput => ({
  familyId: FAMILY_ID,
  feeId: FEE_ID,
  month: "2025-01",
  amount: 15000,
  amountSource: "config",
  ...overrides,
});

async function headOf(input: PaymentInput, eventType = "PaymentDue", seq = 1): Promise<JournalEvent> {
  const payload = paymentPayload(fee, input);
  return {
    familyId: FAMILY_ID,
    childId: CHILD_ID,
    stream: paymentStream(CHILD_ID, FEE_ID, input.month),
    seq,
    kind: "payment",
    day: "2025-01-15",
    eventType,
    payload,
    contentHash: await contentHash(payload),
    source: "payments-watch",
    recordedAt: AT,
  };
}

describe("paymentStream", () => {
  it("joins Child, Fee and month", () => {
    expect(paymentStream("c1", "f1", "2025-01")).toBe("payment:c1:f1:2025-01");
  });
});

describe("paymentPayload", () => {
  it("holds the full state with ISO dates", () => {
    const payload = paymentPayload(fee, payment({ status: "paid", notifiedAt: AT, decidedBy: "1000001" }));
    expect(payload).toEqual({
      status: "paid",
      amount: 15000,
      amountSource: "config",
      dueDay: 15,
      organizer: "Example Organizer",
      month: "2025-01",
      feeId: FEE_ID,
      childId: CHILD_ID,
      familyId: FAMILY_ID,
      notifiedAt: AT.toISOString(),
      remindedAt: null,
      decidedAt: null,
      decidedBy: "1000001",
    });
  });

  it("holds no account, NIP, title, recipient name or source URL", () => {
    const secret = exampleFee({ nip: "1234567890", sourceUrl: "https://example.org/fee" });
    const text = JSON.stringify(paymentPayload(secret, payment()));
    for (const value of [secret.account, "1234567890", secret.title, secret.recipientName, "https://example.org/fee"]) {
      expect(text).not.toContain(value);
    }
  });
});

describe("planPaymentDue", () => {
  it("gives PaymentDue with seq 1 when there is no head", async () => {
    const event = await planPaymentDue(undefined, fee, payment());
    expect(event).toMatchObject({
      familyId: FAMILY_ID,
      childId: CHILD_ID,
      stream: `payment:${CHILD_ID}:${FEE_ID}:2025-01`,
      seq: 1,
      kind: "payment",
      day: "2025-01-15",
      eventType: "PaymentDue",
      source: "payments-watch",
    });
    expect(event?.contentHash).toBe(await contentHash(event?.payload));
  });

  it("pads a one-digit due day", async () => {
    const event = await planPaymentDue(undefined, exampleFee({ dueDay: 5 }), payment());
    expect(event?.day).toBe("2025-01-05");
  });

  it("gives nothing when the hash is the same", async () => {
    expect(await planPaymentDue(await headOf(payment()), fee, payment())).toBeNull();
  });

  it("gives PaymentChanged with the next seq when the amount changes", async () => {
    const event = await planPaymentDue(await headOf(payment()), fee, payment({ amount: 16000, amountSource: "page" }));
    expect(event).toMatchObject({ seq: 2, eventType: "PaymentChanged", payload: { amount: 16000, amountSource: "page" } });
  });

  it("gives nothing when the head is decided", async () => {
    const head = await headOf(payment({ status: "paid" }), "PaymentPaid");
    expect(await planPaymentDue(head, fee, payment({ amount: 16000 }))).toBeNull();
  });

  it("gives nothing for an amount of 0 or less", async () => {
    expect(await planPaymentDue(undefined, fee, payment({ amount: 0 }))).toBeNull();
    expect(await planPaymentDue(await headOf(payment()), fee, payment({ amount: -1 }))).toBeNull();
  });
});

describe("planPaymentDecision", () => {
  it("gives PaymentPaid for a pending head", async () => {
    const event = await planPaymentDecision(await headOf(payment()), "paid", "1000001", AT);
    expect(event).toMatchObject({
      seq: 2,
      kind: "payment",
      day: "2025-01-15",
      eventType: "PaymentPaid",
      source: "payments-watch",
      payload: { status: "paid", decidedBy: "1000001", decidedAt: AT.toISOString(), amount: 15000 },
    });
    expect(event?.contentHash).toBe(await contentHash(event?.payload));
  });

  it("gives PaymentSkipped for a pending head", async () => {
    const event = await planPaymentDecision(await headOf(payment()), "skipped", "1000001", AT);
    expect(event).toMatchObject({ eventType: "PaymentSkipped", payload: { status: "skipped" } });
  });

  it("gives nothing for a second decision", async () => {
    const head = await headOf(payment({ status: "paid" }), "PaymentPaid", 2);
    expect(await planPaymentDecision(head, "skipped", "1000001", AT)).toBeNull();
  });
});

describe("checkCompletedForPayments", () => {
  it("gives a CheckCompleted event in the check stream of the Child", async () => {
    const event = await checkCompletedForPayments(FAMILY_ID, CHILD_ID, AT);
    expect(event).toMatchObject({
      childId: CHILD_ID,
      stream: `check:payments-watch:${CHILD_ID}`,
      seq: 1,
      kind: "check",
      day: "2025-01-12",
      eventType: "CheckCompleted",
      source: "payments-watch",
    });
  });
});
