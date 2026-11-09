import { storedPaymentsExport } from "../stored-payments.ts";
import { entryDeps } from "./common.ts";

/** Read-only: the stored Payments of one month. It reads Supabase only. */
export default async function storedPayments(input: unknown = {}) {
  return storedPaymentsExport(await entryDeps(), input);
}
