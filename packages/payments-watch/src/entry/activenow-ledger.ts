import { countFetches } from "@automations/shared";
import { kodyHost } from "@automations/shared/kody";
import { activenowLedgerExport } from "../activenow-ledger-export.ts";
import { entryDeps } from "./common.ts";

/** Read-only: ActiveNow ledger rows and Fee rows for setting up ActiveNow Fees. The count covers Supabase too. */
export default async function activenowLedger(input: unknown = {}) {
  const counter = countFetches(kodyHost.fetch);
  const deps = await entryDeps({ ...kodyHost, fetch: counter.fetch });
  return activenowLedgerExport({ ...deps, counter }, input);
}
