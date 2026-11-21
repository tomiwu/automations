import type { Account, Config } from "@automations/shared";
import { utcDay, type FetchCount } from "@automations/shared";
import type { Fee } from "@automations/librus-data";
import { ACTIVE_NOW_BLOCK, createHttp } from "@tomiwu/activities-watch";
import { checkKeys, inputObject, withFetches, type ExportDeps } from "@tomiwu/librus-watch";
import { isActiveNowBlock, readActiveNowLedger, type LedgerBanner, type LedgerKind } from "./activenow-ledger.ts";

const MAX_ERROR = 300;

export interface LedgerExportRow {
  date: string;
  title: string;
  amount: number;
  kind: LedgerKind;
  upcoming: boolean;
}

export interface LedgerExportAccount {
  accountId: string;
  childId: string;
  child: string;
  group: string | null;
  origin: string;
  banner: LedgerBanner | null;
  rows: LedgerExportRow[];
  olderRows: number;
  matched: { checked: boolean; openThroughToday: number } | null;
  error: string | null;
}

export interface LedgerExportFee {
  id: string;
  childId: string;
  organizer: string;
  recipientName: string;
  account: string;
  nip: string | null;
  title: string;
  dueDay: number;
  notifyDay: number;
  reminderDay: number;
  amounts: Record<string, number>;
  sourceUrl: string | null;
  accountId: string | null;
  enabled: boolean;
  activenowWithoutAccount: boolean;
}

export interface ActivenowLedgerExport {
  today: string;
  from: string;
  accounts: LedgerExportAccount[];
  fees: LedgerExportFee[];
}

function fromDay(today: string, monthsBack: number): string {
  const [year, month] = today.split("-").map(Number);
  let y = year!;
  let m = month! - (monthsBack - 1);
  while (m <= 0) {
    m += 12;
    y -= 1;
  }
  return `${y}-${String(m).padStart(2, "0")}-01`;
}

function resolveMonthsBack(value: unknown): number {
  if (value === undefined) return 3;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 6) {
    throw new Error("monthsBack must be an integer 1..6.");
  }
  return value;
}

function activenowUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname.toLowerCase().includes("activenow");
  } catch {
    return url.toLowerCase().includes("activenow");
  }
}

function feeRow(fee: Fee): LedgerExportFee {
  return {
    id: fee.id,
    childId: fee.childId,
    organizer: fee.organizer,
    recipientName: fee.recipientName,
    account: fee.account,
    nip: fee.nip,
    title: fee.title,
    dueDay: fee.dueDay,
    notifyDay: fee.notifyDay,
    reminderDay: fee.reminderDay,
    amounts: fee.amounts,
    sourceUrl: fee.sourceUrl,
    accountId: fee.accountId,
    enabled: fee.enabled,
    activenowWithoutAccount: activenowUrl(fee.sourceUrl) && fee.accountId === null,
  };
}

function childName(config: Config, childId: string): string {
  return config.children.find((child) => child.id === childId)?.name ?? "";
}

function splitRows(
  all: readonly { date: string; title: string; amount: number; kind: LedgerKind }[],
  from: string,
  today: string,
): { rows: LedgerExportRow[]; olderRows: number } {
  let olderRows = 0;
  const rows: LedgerExportRow[] = [];
  for (const row of all) {
    if (row.date < from) {
      olderRows += 1;
      continue;
    }
    rows.push({ ...row, upcoming: row.date > today });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  return { rows, olderRows };
}

function errorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, MAX_ERROR);
}

function accountShell(config: Config, account: Account): LedgerExportAccount {
  const child = childName(config, account.child_id);
  return {
    accountId: account.id,
    childId: account.child_id,
    child,
    group: account.group ?? null,
    origin: account.origin,
    banner: null,
    rows: [],
    olderRows: 0,
    matched: null,
    error: null,
  };
}

async function readOne(
  deps: ExportDeps,
  config: Config,
  account: Account,
  today: string,
  from: string,
  blocked: { value: boolean },
): Promise<LedgerExportAccount> {
  const base = accountShell(config, account);
  if (blocked.value) return { ...base, error: ACTIVE_NOW_BLOCK };
  try {
    const http = createHttp(deps.runtime);
    const secrets = {
      login: await deps.runtime.secret(account.login_secret),
      password: await deps.runtime.secret(account.password_secret),
    };
    const read = await readActiveNowLedger(
      http,
      account.origin,
      account.id,
      secrets,
      account.group ?? base.child,
      today,
    );
    const split = splitRows(read.rows, from, today);
    return {
      ...base,
      banner: read.banner,
      rows: split.rows,
      olderRows: split.olderRows,
      matched: { checked: read.matched.checked, openThroughToday: read.matched.openThroughToday },
    };
  } catch (error) {
    if (isActiveNowBlock(error)) blocked.value = true;
    return { ...base, error: errorMessage(error) };
  }
}

/** Read-only export: ActiveNow settlements rows for each enabled Account and every Fee row from Supabase. */
export async function activenowLedgerExport(
  deps: ExportDeps,
  input: unknown = {},
): Promise<ActivenowLedgerExport & { fetches?: FetchCount }> {
  const object = inputObject(input);
  checkKeys(object, ["monthsBack"]);
  const monthsBack = resolveMonthsBack(object.monthsBack);
  const config = await deps.storage.loadConfig(deps.familyId);
  const fees = (await deps.storage.listFees(deps.familyId)).map(feeRow);
  const today = utcDay(deps.runtime.now());
  const from = fromDay(today, monthsBack);
  const accountsConfig = config.accounts.filter((item) => item.service === "activenow" && item.enabled);
  const blocked = { value: false };
  const accounts: LedgerExportAccount[] = [];
  let rowCount = 0;
  let errors = 0;
  for (const account of accountsConfig) {
    const row = await readOne(deps, config, account, today, from, blocked);
    accounts.push(row);
    if (row.error) errors += 1;
    else rowCount += row.rows.length;
  }
  deps.runtime.log("info", `activenow-ledger export: accounts=${accounts.length} rows=${rowCount} errors=${errors}`);
  return withFetches(deps, { today, from, accounts, fees });
}