const ID_PATTERN = /^[0-9]{1,20}$/;

/** Parses Telegram user IDs from an array or from a comma-separated string. */
export function parseAllowlist(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : splitIds(value);
  const ids = parts.map((part) => String(part).trim()).filter((part) => part !== "");
  if (ids.length > 20) throw new Error("The allowlist can hold at most 20 ids.");
  const bad = ids.filter((id) => !ID_PATTERN.test(id));
  if (bad.length > 0) throw new Error("Allowlist ids must be decimal digits.");
  return [...new Set(ids)];
}

function splitIds(value: unknown): unknown[] {
  if (typeof value !== "string") throw new Error("The allowlist must be a list of ids.");
  return value.split(",");
}

/** True when this private chat is from an allowlisted Telegram user. */
export function senderAllowed(allowlist: readonly string[], sender: { userId: string; chatType: string }): boolean {
  if (sender.chatType !== "private") return false;
  return allowlist.includes(sender.userId);
}
