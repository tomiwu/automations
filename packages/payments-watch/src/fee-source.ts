import type { AmountSource, Fee } from "@automations/librus-data";

/** The amount of one Fee for one month, and where it comes from. */
export interface FeeAmount {
  feeId: string;
  /** Month `YYYY-MM`. */
  month: string;
  /** Amount in grosze. */
  amount: number;
  source: AmountSource;
}

export interface FeeSource {
  amountFor(fee: Fee, month: string): Promise<FeeAmount | undefined>;
}

/** Fee source that reads the `amounts` of the Fee row. */
export function createConfigFeeSource(): FeeSource {
  return {
    amountFor: async (fee, month) => {
      const amount = fee.amounts[month];
      return amount === undefined ? undefined : { feeId: fee.id, month, amount, source: "config" };
    },
  };
}
