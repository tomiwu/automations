/** Returns a plain object, or null. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Rejects keys that are not in the allowed list. */
export function rejectUnknown(raw: unknown, allowed: readonly string[]): Record<string, unknown> {
  const record = asRecord(raw);
  if (!record) throw new Error("The input must be an object.");
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new Error(`Unknown keys: ${extra.join(", ")}`);
  return record;
}

/** Reads a finite number, or null. */
export function numberField(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

/** Reads a non-empty string, or null. */
export function textField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") return null;
  return value;
}

const TRUE_VALUES = new Set<unknown>([true, "true", "on"]);
const FALSE_VALUES = new Set<unknown>([false, "false", "off"]);

function missingActive(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

/** Reads a boolean. An empty value uses `whenMissing`. */
export function readActive(value: unknown, whenMissing: boolean): boolean {
  if (missingActive(value)) return whenMissing;
  if (TRUE_VALUES.has(value)) return true;
  if (FALSE_VALUES.has(value)) return false;
  throw new Error("active must be true or false.");
}
