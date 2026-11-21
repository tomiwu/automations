import type { Session } from "./sessions.ts";

export const ACTIVENOW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export interface CacheStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
}

export interface CacheEntry {
  attemptedAt: string;
  fetchedAt: string | null;
  sessions: Session[];
  error: string | null;
}

export const cacheKey = (accountId: string): string => `activenow-cache:${accountId}`;

function isEntry(value: unknown): value is CacheEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.attemptedAt === "string" && Array.isArray(entry.sessions);
}

function parseEntry(stored: unknown): CacheEntry | undefined {
  const value = typeof stored === "string" ? (JSON.parse(stored) as unknown) : stored;
  return isEntry(value) ? { ...value, fetchedAt: value.fetchedAt ?? null, error: value.error ?? null } : undefined;
}

export async function loadEntry(store: CacheStore, accountId: string): Promise<CacheEntry | undefined> {
  const stored = await store.get(cacheKey(accountId));
  if (stored == null || stored === "") return undefined;
  try {
    return parseEntry(stored);
  } catch {
    return undefined;
  }
}

export async function saveEntry(store: CacheStore, accountId: string, entry: CacheEntry): Promise<void> {
  await store.set(cacheKey(accountId), JSON.stringify(entry));
}

export const nextFetchAt = (entry: CacheEntry, ttlMs: number): Date =>
  new Date(Date.parse(entry.attemptedAt) + ttlMs);

export const isFresh = (entry: CacheEntry, now: Date, ttlMs: number): boolean =>
  now.getTime() < nextFetchAt(entry, ttlMs).getTime();

export function goodEntry(now: Date, sessions: Session[]): CacheEntry {
  const attemptedAt = now.toISOString();
  return { attemptedAt, fetchedAt: attemptedAt, sessions, error: null };
}

export function keptEntry(previous: CacheEntry | undefined, now: Date, error: string | null): CacheEntry {
  const { fetchedAt = null, sessions = [] } = previous ?? {};
  return { attemptedAt: now.toISOString(), fetchedAt, sessions, error };
}
