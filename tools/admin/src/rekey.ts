import { decryptCredential, encryptCredential, importCredentialKey } from "@automations/shared";
import type { RestClient, Row } from "./rest.ts";

export const LIBRUS_ORIGIN = "https://synergia.librus.pl";

export interface RekeyDeps {
  rest: RestClient;
  env: Record<string, string | undefined>;
  now: () => number;
  print: (line: string) => void;
  readSecret: (prompt: string) => Promise<string>;
}

export type CredentialStatus = "ok" | "does not decrypt" | "missing";

export function cleanValue(name: string, raw: string | undefined): string {
  const value = (raw ?? "").replace(/[\r\n]+$/, "");
  return /_(EMAIL|USER|LOGIN)$/.test(name) ? value.trim() : value;
}

export function credentialNames(accounts: readonly Row[], stored: readonly Row[]): string[] {
  const fromAccounts = accounts.flatMap((account) => [account.login_secret, account.password_secret]);
  const isName = (value: unknown): value is string => typeof value === "string" && value !== "";
  const names = new Set([...fromAccounts.filter(isName), ...stored.map((row) => String(row.name))]);
  return [...names].sort();
}

async function decryptOrEmpty(key: CryptoKey | undefined, familyId: string, name: string, sealed: unknown): Promise<string> {
  if (key === undefined || typeof sealed !== "string") return "";
  try {
    return await decryptCredential(key, familyId, name, sealed);
  } catch {
    return "";
  }
}

async function valueOf(deps: RekeyDeps, oldKey: CryptoKey | undefined, familyId: string, name: string, sealed: unknown): Promise<string> {
  const fromEnv = cleanValue(name, deps.env[name]);
  if (fromEnv !== "") return fromEnv;
  const old = await decryptOrEmpty(oldKey, familyId, name, sealed);
  if (old !== "") return old;
  return cleanValue(name, await deps.readSecret(`${name} is not in .env; type it (hidden, Enter to skip): `));
}

async function optionalKey(value: string | undefined): Promise<CryptoKey | undefined> {
  if (!value) return undefined;
  try {
    return await importCredentialKey(value.trim());
  } catch {
    return undefined;
  }
}

export async function verifyAll(deps: RekeyDeps, key: CryptoKey, familyId: string, names: readonly string[]): Promise<number> {
  const rows = await deps.rest.select("credentials", `select=name,ciphertext&family_id=eq.${encodeURIComponent(familyId)}`);
  const sealed = new Map(rows.map((row) => [String(row.name), row.ciphertext]));
  let bad = 0;
  for (const name of names) {
    const status: CredentialStatus = !sealed.has(name)
      ? "missing"
      : (await decryptOrEmpty(key, familyId, name, sealed.get(name))) !== ""
        ? "ok"
        : "does not decrypt";
    if (status !== "ok") bad += 1;
    deps.print(`${name}: ${status}`);
  }
  return bad;
}

export async function rekey(deps: RekeyDeps, familyId: string): Promise<number> {
  const newKey = await importCredentialKey(cleanValue("KEY", deps.env.NEW_CREDENTIAL_KEY).trim());
  const oldKey = await optionalKey(deps.env.CREDENTIAL_KEY);
  const family = `family_id=eq.${encodeURIComponent(familyId)}`;
  const accounts = await deps.rest.select("accounts", `select=service,origin,login_secret,password_secret&${family}`);
  const stored = await deps.rest.select("credentials", `select=name,ciphertext&${family}`);
  const names = credentialNames(accounts, stored);
  const sealed = new Map(stored.map((row) => [String(row.name), row.ciphertext]));
  const updatedAt = new Date(deps.now()).toISOString();
  const rows: Row[] = [];
  for (const name of names) {
    const value = await valueOf(deps, oldKey, familyId, name, sealed.get(name));
    if (value !== "") rows.push({ family_id: familyId, name, ciphertext: await encryptCredential(newKey, familyId, name, value), updated_at: updatedAt });
  }
  if (rows.length === 0) throw new Error("No credential values found; nothing was stored");
  await deps.rest.upsert("credentials", rows);
  deps.print(`Encrypted ${rows.length} of ${names.length} credentials with the new key`);
  const fixed = await deps.rest.update("accounts", `${family}&service=eq.librus&origin=is.null`, { origin: LIBRUS_ORIGIN });
  if (fixed.length > 0) deps.print(`Set the Librus origin on ${fixed.length} account(s)`);
  return verifyAll(deps, newKey, familyId, names);
}
