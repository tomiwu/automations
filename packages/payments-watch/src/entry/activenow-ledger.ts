import { countFetches } from "@automations/shared";
import { activenowLedgerExport } from "../activenow-ledger-export.ts";
import { entryDeps } from "./common.ts";

/** Read-only: ActiveNow ledger rows and Fee rows for setting up ActiveNow Fees. */
export default async function activenowLedger(input: unknown = {}) {
  const base = await entryDeps();
  const counter = countFetches(base.runtime.fetch);
  return activenowLedgerExport({ ...base, runtime: { ...base.runtime, fetch: counter.fetch }, counter }, input);
}