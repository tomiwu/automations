/**
 * The cache of the ActiveNow Sessions. ActiveNow blocks the network after repeated fetches, so a Watcher fetches
 * at most once in the TTL for each Account. The TTL counts from the last attempt, not from the last success.
 */
import type { Session } from "./sessions.ts";

/** Default time between two fetches of one Account. */
export const ACTIVENOW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** The key-value storage of the package. `KodyStorage` of `@automations/shared/kody` fits it. */
export interface CacheStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
}

export interface CacheEntry {
  /** ISO time of the last fetch attempt, good or not. */
  attemptedAt: string;
  /** ISO time of the last good fetch, or null when none was good. */
  fetchedAt: string | null;
  /** The Sessions of the last good fetch. */
  sessions: Session[];
  /** The error of the last attempt, or null when it was good. */
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

/** Reads the entry of one Account. A missing or damaged entry gives undefined. */
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

/** Returns the first time that a new fetch is allowed. */
export const nextFetchAt = (entry: CacheEntry, ttlMs: number): Date =>
  new Date(Date.parse(entry.attemptedAt) + ttlMs);

export const isFresh = (entry: CacheEntry, now: Date, ttlMs: number): boolean =>
  now.getTime() < nextFetchAt(entry, ttlMs).getTime();

/** Makes the entry of a good fetch. */
export function goodEntry(now: Date, sessions: Session[]): CacheEntry {
  const attemptedAt = now.toISOString();
  return { attemptedAt, fetchedAt: attemptedAt, sessions, error: null };
}

/** Makes the entry of an empty or failed attempt. The old Sessions stay. */
export function keptEntry(previous: CacheEntry | undefined, now: Date, error: string | null): CacheEntry {
  const { fetchedAt = null, sessions = [] } = previous ?? {};
  return { attemptedAt: now.toISOString(), fetchedAt, sessions, error };
}
