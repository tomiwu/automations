import type { KodyStorage } from "@automations/shared/kody";

/** One user that may open the Dashboard. `tokenDigest` is the SHA-256 of the login token, in hex. */
export interface DashboardUser {
  user: string;
  tokenDigest: string;
}

export const DASHBOARD_ALLOWLIST_KEY = "dashboard-allowlist";

function userName(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error("user must be 1 to 64 letters, digits, _ or -.");
  return value;
}

function digestOf(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("tokenDigest must be 64 hex digits (SHA-256 of the token).");
  return value;
}

function userOf(entry: unknown): DashboardUser {
  if (typeof entry !== "object" || entry === null) throw new Error("Each allowlist entry needs a user and a tokenDigest.");
  const fields = entry as Record<string, unknown>;
  return { user: userName(fields.user), tokenDigest: digestOf(fields.tokenDigest) };
}

/** Validates the allowlist. An empty list lets no one in. */
export function parseDashboardAllowlist(raw: unknown): DashboardUser[] {
  if (!Array.isArray(raw)) throw new Error("allowlist must be a list of { user, tokenDigest }.");
  return raw.map(userOf);
}

/** Reads the allowlist from the package storage. It is empty when not set. */
export async function loadDashboardAllowlist(storage: Pick<KodyStorage, "get">): Promise<DashboardUser[]> {
  const stored = await storage.get(DASHBOARD_ALLOWLIST_KEY);
  if (stored == null || stored === "") return [];
  return parseDashboardAllowlist(typeof stored === "string" ? JSON.parse(stored) : stored);
}

/** Validates and saves the allowlist. */
export async function saveDashboardAllowlist(storage: KodyStorage, raw: unknown): Promise<DashboardUser[]> {
  const allowlist = parseDashboardAllowlist(raw);
  await storage.set(DASHBOARD_ALLOWLIST_KEY, JSON.stringify(allowlist));
  return allowlist;
}
