import type { AmountSource, Fee } from "@automations/librus-data";

export interface FeeAmount {
  feeId: string;
  /** Month `YYYY-MM`. */
  month: string;
  /** Amount in grosze. */
  amount: number;
  source: AmountSource;
  /** The config amount, when the amount comes from the page and the config has a different amount. */
  configAmount?: number;
}

/**
 * What the page of the last `amountFor` call showed about the charge. `listed`: the charge is there.
 * `candidate`: the charge may be void or the Child may be withdrawn; `evidence` is the host class and the observation
 * code (no personal data). A page that was not read well (failed, capped, skipped, empty) gives no observation.
 */
export type PageObservation =
  | { kind: "listed" }
  | { kind: "candidate"; reason: "organizer_void" | "organizer_withdrawn"; evidence: string };

export interface FeeSource {
  amountFor(fee: Fee, month: string): Promise<FeeAmount | undefined>;
  /** The observation of the last `amountFor` call for the Fee and the month. It makes no fetch. */
  observationFor?(fee: Fee, month: string): PageObservation | undefined;
  /** When every matched charge of the month is covered on a checked ledger. */
  settledFor?(fee: Fee, month: string): Promise<boolean>;
}

export function createConfigFeeSource(): FeeSource {
  return {
    amountFor: async (fee, month) => {
      const amount = fee.amounts[month];
      return amount === undefined ? undefined : { feeId: fee.id, month, amount, source: "config" };
    },
  };
}
