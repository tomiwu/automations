export const DEFAULT_FETCH_RESERVE = 150;
export const WEEKLY_FETCH_LIMIT = 2500;

const CAP_ERROR = /EntitlementLimitError|plan limit reached/i;

export function isFetchCapError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return CAP_ERROR.test(text);
}

export interface LedgerStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
}

export interface FetchLedger {
  /** The Monday (`YYYY-MM-DD`, UTC) of the week of the count. */
  week: string;
  used: number;
  capHitDay?: string;
}

export const LEDGER_KEY = "fetch-ledger";

const DAY_MS = 86_400_000;

export const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

/** The Monday (`YYYY-MM-DD`, UTC) of the UTC week of a time. */
export function utcWeekOf(date: Date): string {
  const sinceMonday = (date.getUTCDay() + 6) % 7;
  return utcDay(new Date(date.getTime() - sinceMonday * DAY_MS));
}

function parseLedger(stored: unknown): Partial<FetchLedger> {
  try {
    const value = typeof stored === "string" ? (JSON.parse(stored) as unknown) : stored;
    return typeof value === "object" && value !== null ? (value as Partial<FetchLedger>) : {};
  } catch {
    return {};
  }
}

/** Reads the ledger of the week of `now`. A ledger of an older week, a damaged one or none gives zero. */
export async function loadLedger(store: LedgerStore, now: Date): Promise<FetchLedger> {
  const week = utcWeekOf(now);
  const stored = parseLedger(await store.get(LEDGER_KEY));
  if (stored.week !== week || typeof stored.used !== "number") return { week, used: 0 };
  return typeof stored.capHitDay === "string" ? { week, used: stored.used, capHitDay: stored.capHitDay } : { week, used: stored.used };
}

export interface FetchBudget {
  /** The fetches that stay in the week. It is 0 on a UTC day when a fetch failed on the plan limit. */
  remaining(): Promise<number>;
  /** Adds the fetches of a run to the ledger. With `capHit`, it also marks the current UTC day. */
  record(fetches: number, capHit?: boolean): Promise<void>;
}

export interface FetchBudgetOptions {
  store: LedgerStore;
  now: () => Date;
  limit?: number;
}

export function createFetchBudget({ store, now, limit = WEEKLY_FETCH_LIMIT }: FetchBudgetOptions): FetchBudget {
  return {
    async remaining() {
      const ledger = await loadLedger(store, now());
      if (ledger.capHitDay === utcDay(now())) return 0;
      return Math.max(0, limit - ledger.used);
    },
    async record(fetches, capHit = false) {
      const ledger = await loadLedger(store, now());
      const next: FetchLedger = { ...ledger, used: ledger.used + fetches };
      if (capHit) next.capHitDay = utcDay(now());
      await store.set(LEDGER_KEY, JSON.stringify(next));
    },
  };
}

/** True when the remaining fetches are below the reserve. Without a budget it is false. */
export async function belowReserve(budget: FetchBudget | undefined, reserve = DEFAULT_FETCH_RESERVE): Promise<boolean> {
  if (!budget) return false;
  return (await budget.remaining()) < reserve;
}

export const formatReserveSkip = (parts: readonly string[]): string => `budget reserve: skipped ${parts.join(", ")}`;
