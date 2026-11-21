import type { Account, Config } from "@automations/shared";
import type { Fee, StorageAdapter } from "@automations/librus-data";
import { createHttp, REQUEST_TIMEOUT_MS, type Http } from "@tomiwu/activities-watch";
import { localDate, t, type MessageKey, type Runtime } from "@automations/shared";
import {
  isActiveNowBlock,
  readActiveNowLedger,
  type LedgerRow,
  type MatchedCharge,
  type ReadLedgerResult,
} from "./activenow-ledger.ts";
import { formatAmount } from "./engine.ts";
import { createConfigFeeSource, type FeeAmount, type FeeSource, type PageObservation } from "./fee-source.ts";
import { createWebFeeSource, type WebFeeSourceDeps } from "./page-source.ts";

export interface LedgerStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
}

export interface ActiveNowFeeSourceDeps {
  runtime: Runtime;
  storage: StorageAdapter;
  familyId: string;
  ledgerStore: LedgerStore;
  /** Fees that are not tied to an ActiveNow Account use this source. */
  fallback: FeeSource;
}

interface CachedLedger {
  day: string;
  rows: LedgerRow[];
  banner: ReadLedgerResult["banner"];
  matched: ReadLedgerResult["matched"];
  readOk: boolean;
}

interface AccountLedger {
  account: Account;
  cache?: CachedLedger;
  loaded: boolean;
}

export interface ActivenowPassStats {
  accounts: number;
  rows: number;
  open: number;
  checked: boolean;
}

const CACHE_PREFIX = "activenow-ledger:";

function cacheKey(accountId: string): string {
  return `${CACHE_PREFIX}${accountId}`;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9ąćęłńóśźż]+/i)
    .filter((word) => word.length > 0);
}

function feeMatchesCharge(fee: Fee, chargeTitle: string): boolean {
  const words = wordsOf(fee.title);
  if (words.length === 0) return false;
  const hay = chargeTitle.toLowerCase();
  return words.every((word) => hay.includes(word));
}

function chargesForMonth(rows: readonly LedgerRow[], month: string): LedgerRow[] {
  return rows.filter((row) => row.kind === "charge" && row.date.startsWith(`${month}-`));
}

function matchedForMonth(charges: readonly MatchedCharge[], month: string): MatchedCharge[] {
  return charges.filter((row) => row.date.startsWith(`${month}-`));
}

async function loadCache(store: LedgerStore, accountId: string, day: string): Promise<CachedLedger | undefined> {
  const raw = await store.get(cacheKey(accountId));
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as CachedLedger;
    return parsed.day === day ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function saveCache(store: LedgerStore, accountId: string, value: CachedLedger): Promise<void> {
  await store.set(cacheKey(accountId), JSON.stringify(value));
}

async function loginSecrets(runtime: ActiveNowFeeSourceDeps["runtime"], account: Account): Promise<{ login: string; password: string }> {
  return {
    login: await runtime.secret(account.login_secret),
    password: await runtime.secret(account.password_secret),
  };
}

async function fetchLedger(
  deps: ActiveNowFeeSourceDeps,
  account: Account,
  childName: string | null,
  day: string,
  http: Http,
): Promise<CachedLedger> {
  const secrets = await loginSecrets(deps.runtime, account);
  const read = await readActiveNowLedger(http, account.origin, account.id, secrets, account.group ?? childName, day);
  const entry: CachedLedger = { day, rows: read.rows, banner: read.banner, matched: read.matched, readOk: true };
  await saveCache(deps.ledgerStore, account.id, entry);
  return entry;
}

async function readAccount(
  deps: ActiveNowFeeSourceDeps,
  account: Account,
  childName: string | null,
  day: string,
  http: Http,
  blocked: { value: boolean },
): Promise<AccountLedger> {
  if (blocked.value) return { account, loaded: false };
  const cached = await loadCache(deps.ledgerStore, account.id, day);
  if (cached) return { account, cache: cached, loaded: true };
  try {
    const entry = await fetchLedger(deps, account, childName, day, http);
    return { account, cache: entry, loaded: true };
  } catch (error) {
    if (isActiveNowBlock(error)) blocked.value = true;
    return { account, loaded: false };
  }
}

async function accountsOf(deps: ActiveNowFeeSourceDeps): Promise<{ config: Config; activenow: Account[] }> {
  const config = await deps.storage.loadConfig(deps.familyId);
  const activenow = config.accounts.filter((item) => item.service === "activenow" && item.enabled);
  return { config, activenow };
}

function childName(config: Config, childId: string): string | null {
  return config.children.find((child) => child.id === childId)?.name ?? null;
}

function feeUsesActivenow(fee: Fee, accounts: readonly Account[]): boolean {
  if (!fee.accountId) return false;
  return accounts.some((item) => item.id === fee.accountId && item.service === "activenow");
}

function enabledFeesForAccount(fees: readonly Fee[], accountId: string): Fee[] {
  return fees.filter((fee) => fee.enabled && fee.accountId === accountId);
}

function assignCharge(feeList: readonly Fee[], charge: LedgerRow): Fee | undefined {
  if (feeList.length === 1) return feeList[0];
  const matches = feeList.filter((fee) => feeMatchesCharge(fee, charge.title));
  return matches.length === 1 ? matches[0] : undefined;
}

async function notifyRow(
  deps: ActiveNowFeeSourceDeps,
  config: Config,
  childId: string,
  key: string,
  message: MessageKey,
  params: Record<string, string>,
): Promise<void> {
  const child = config.children.find((item) => item.id === childId);
  if (!child) return;
  for (const recipient of config.recipients.filter((item) => item.child_ids.includes(childId))) {
    await deps.storage.enqueueNotification({
      key: `${key}:${recipient.telegram_chat_id}`,
      familyId: deps.familyId,
      chatId: recipient.telegram_chat_id,
      text: t(recipient.language, message, { child: child.name, ...params }),
    });
  }
}

async function notifyUnmatched(
  deps: ActiveNowFeeSourceDeps,
  config: Config,
  account: Account,
  charges: readonly MatchedCharge[],
  feeList: readonly Fee[],
): Promise<void> {
  for (const charge of charges) {
    if (charge.status === "covered" || charge.status === "upcoming") continue;
    if (assignCharge(feeList, charge)) continue;
    await notifyRow(deps, config, account.child_id, `activenow-unmatched:${charge.key}`, "payment.activenow_unmatched", {
      date: charge.date,
      amount: formatAmount(charge.amount),
    });
  }
}

async function notifyMismatch(deps: ActiveNowFeeSourceDeps, config: Config, account: Account, day: string): Promise<void> {
  await notifyRow(deps, config, account.child_id, `activenow-mismatch:${account.id}:${day}`, "payment.activenow_mismatch", {});
}

function activenowUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname.toLowerCase().includes("activenow");
  } catch {
    return url.toLowerCase().includes("activenow");
  }
}

async function notifyActivenowMissingAccount(deps: WebFeeSourceDeps, fee: Fee): Promise<void> {
  const config = await deps.storage.loadConfig(deps.familyId);
  const child = config.children.find((item) => item.id === fee.childId);
  if (!child) return;
  const day = localDate(deps.runtime.now(), config.family.timezone);
  for (const recipient of config.recipients.filter((item) => item.child_ids.includes(fee.childId))) {
    await deps.storage.enqueueNotification({
      key: `failure:${fee.id}:${day}:${recipient.telegram_chat_id}`,
      familyId: deps.familyId,
      chatId: recipient.telegram_chat_id,
      text: t(recipient.language, "error.fetch", { child: child.name, reason: "ActiveNow Fee needs accountId" }),
    });
  }
}

function createWebFallback(deps: Omit<ActiveNowFeeSourceDeps, "fallback">): FeeSource {
  const webDeps: WebFeeSourceDeps = { runtime: deps.runtime, storage: deps.storage, familyId: deps.familyId };
  const web = createWebFeeSource(webDeps);
  const configSource = createConfigFeeSource();
  return {
    observationFor: web.observationFor?.bind(web),
    async amountFor(fee, month) {
      if (activenowUrl(fee.sourceUrl) && !fee.accountId) {
        await notifyActivenowMissingAccount(webDeps, fee);
        return configSource.amountFor(fee, month);
      }
      return web.amountFor(fee, month);
    },
  };
}

export function createActiveNowFeeSource(deps: ActiveNowFeeSourceDeps): FeeSource & { passStats(): ActivenowPassStats | undefined } {
  const configSource = createConfigFeeSource();
  const observations = new Map<string, PageObservation>();
  const settled = new Map<string, boolean>();
  let stats: ActivenowPassStats | undefined;
  let ledgers = new Map<string, AccountLedger>();
  let fees: Fee[] = [];
  let passReady = false;
  const blocked = { value: false };

  async function ensurePass(): Promise<void> {
    if (passReady) return;
    const loaded = await accountsOf(deps);
    fees = await deps.storage.listFees(deps.familyId);
    const day = utcDay(deps.runtime.now());
    const http = createHttp(deps.runtime, REQUEST_TIMEOUT_MS);
    const map = new Map<string, AccountLedger>();
    let rows = 0;
    let open = 0;
    let checked = true;
    for (const account of loaded.activenow) {
      const ledger = await readAccount(deps, account, childName(loaded.config, account.child_id), day, http, blocked);
      map.set(account.id, ledger);
      if (ledger.cache?.readOk) {
        rows += ledger.cache.rows.length;
        open += ledger.cache.matched.openThroughToday;
        if (!ledger.cache.matched.checked) checked = false;
        await notifyUnmatched(deps, loaded.config, account, ledger.cache.matched.charges, enabledFeesForAccount(fees, account.id));
        if (!ledger.cache.matched.checked) {
          deps.runtime.log("warn", "activenow ledger: balance check failed");
          await notifyMismatch(deps, loaded.config, account, day);
        }
      }
    }
    stats = loaded.activenow.length > 0 ? { accounts: loaded.activenow.length, rows, open, checked } : undefined;
    ledgers = map;
    passReady = true;
  }

  function ledgerOf(fee: Fee): AccountLedger | undefined {
    if (!fee.accountId) return undefined;
    return ledgers.get(fee.accountId);
  }

  function monthCharges(fee: Fee, month: string): LedgerRow[] {
    const ledger = ledgerOf(fee);
    if (!ledger?.cache?.readOk) return [];
    const accountFees = enabledFeesForAccount(fees, fee.accountId!);
    const monthRows = chargesForMonth(ledger.cache.rows, month);
    if (accountFees.length === 1) return monthRows;
    return monthRows.filter((row) => assignCharge(accountFees, row)?.id === fee.id);
  }

  return {
    passStats: () => stats,
    observationFor: (fee, month) => observations.get(`${fee.id}:${month}`),
    async amountFor(fee, month) {
      observations.delete(`${fee.id}:${month}`);
      settled.delete(`${fee.id}:${month}`);
      const { activenow } = await accountsOf(deps);
      if (!feeUsesActivenow(fee, activenow)) return deps.fallback.amountFor(fee, month);
      await ensurePass();
      const configAmount = await configSource.amountFor(fee, month);
      const charges = monthCharges(fee, month);
      if (charges.length === 0) {
        const ledger = ledgerOf(fee);
        if (ledger?.cache?.readOk) {
          if (ledger.cache.rows.length > 0) {
            observations.set(`${fee.id}:${month}`, {
              kind: "candidate",
              reason: "organizer_void",
              evidence: "activenow:charge_absent",
            });
          }
          return undefined;
        }
        return configAmount;
      }
      const amount = charges.reduce((sum, row) => sum + row.amount, 0);
      observations.set(`${fee.id}:${month}`, { kind: "listed" });
      const found: FeeAmount = { feeId: fee.id, month, amount, source: "page" };
      const ledger = ledgerOf(fee);
      if (ledger?.cache?.readOk) {
        const matched = matchedForMonth(ledger.cache.matched.charges, month).filter((row) =>
          charges.some((charge) => charge.date === row.date && charge.title === row.title && charge.amount === row.amount),
        );
        if (matched.length > 0 && matched.every((row) => row.status === "covered") && ledger.cache.matched.checked) {
          settled.set(`${fee.id}:${month}`, true);
        }
      }
      return configAmount && configAmount.amount !== amount ? { ...found, configAmount: configAmount.amount } : found;
    },
    async settledFor(fee, month) {
      if (!settled.has(`${fee.id}:${month}`)) await this.amountFor!(fee, month);
      return settled.get(`${fee.id}:${month}`) ?? false;
    },
  };
}

export function createPaymentFeeSource(deps: Omit<ActiveNowFeeSourceDeps, "fallback">): FeeSource & { passStats(): ActivenowPassStats | undefined } {
  return createActiveNowFeeSource({ ...deps, fallback: createWebFallback(deps) });
}

export function logActivenowPass(runtime: Runtime, source: FeeSource): void {
  const stats = (source as { passStats?: () => ActivenowPassStats | undefined }).passStats?.();
  if (!stats) return;
  runtime.log("info", `activenow ledger: accounts=${stats.accounts} rows=${stats.rows} open=${stats.open} checked=${stats.checked ? "yes" : "no"}`);
}