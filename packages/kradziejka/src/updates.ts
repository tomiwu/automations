import type { KeyValue } from "./state.ts";

const SEEN_KEY = "seen-update-ids";
const MAX_IDS = 400;

/**
 * Duplicate guard for a Telegram `update_id`.
 * Kody replay protection reads a header. Telegram puts `update_id` in the JSON body, so the guard is here.
 * The first call claims the id. A later call with the same id returns false.
 */
export async function claimUpdate(kv: KeyValue, updateId: number): Promise<boolean> {
  if (!Number.isSafeInteger(updateId) || updateId < 0) return false;
  const ids = await readIds(kv);
  const id = String(updateId);
  if (ids.includes(id)) return false;
  ids.push(id);
  await kv.set(SEEN_KEY, JSON.stringify(ids.slice(-MAX_IDS)));
  return true;
}

/** Removes an id so a failed attempt can run again. */
export async function releaseUpdate(kv: KeyValue, updateId: number): Promise<void> {
  const id = String(updateId);
  const ids = (await readIds(kv)).filter((item) => item !== id);
  await kv.set(SEEN_KEY, JSON.stringify(ids));
}

async function readIds(kv: KeyValue): Promise<string[]> {
  const raw = await kv.get(SEEN_KEY);
  const data = typeof raw === "string" ? parseJson(raw) : raw;
  if (!Array.isArray(data)) return [];
  return data.filter((item) => typeof item === "string");
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
