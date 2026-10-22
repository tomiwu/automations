import { packageContext, packageStorage } from "kody:runtime";
import type { FetchFn, LogLevel, Runtime } from "./runtime.ts";

/**
 * The names that `kody:runtime` really exports (seen on Kody on 2026-10-22).
 * Code may import only these names; `kody.test.ts` checks every import of `kody:runtime` against this list.
 */
export const KODY_RUNTIME_EXPORTS = [
  "KodyRuntime",
  "createAuthenticatedFetch",
  "credential",
  "credentials",
  "default",
  "email",
  "events",
  "kody",
  "oauthClientCredentials",
  "packageContext",
  "packageSecrets",
  "packageStorage",
  "packages",
  "secretHeaders",
  "workflows",
] as const;

/**
 * The only Kody secret the packages use, as a literal placeholder (Kody requires literal secret names). Kody fills
 * it in when a fetch sends it to the allowed host of the secret. The code never sees the value.
 */
export const SUPABASE_KEY_PLACEHOLDER = "{{secret:SUPABASE_KEY}}";

/** The key-value storage of the package (`packageStorage()` of `kody:runtime`). */
export interface KodyStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
}

/** The platform parts that the Kody Runtime uses. */
export interface KodyHost {
  fetch: FetchFn;
  log(level: LogLevel, message: string): void;
}

/**
 * `secret(name)` gives the service credential with this name (for example `accounts.login_secret`). The value comes
 * from `resolveCredential`: on Kody it is the encrypted row in Supabase, decrypted with the credential key.
 */
export function createKodyRuntime(
  host: KodyHost,
  resolveCredential: (name: string) => Promise<string>,
  now: () => Date = () => new Date(),
): Runtime {
  return {
    fetch: (input, init) => host.fetch(input, init),
    secret: (name) => resolveCredential(name),
    now,
    log: (level, message) => host.log(level, message),
    schedule: () => {
      throw new Error("On Kody, schedules are the jobs in package.json (kody.jobs).");
    },
  };
}

/** Plain (non-secret) settings of one deployment. They live in the package storage, not in the code. */
export interface DeploymentConfig {
  supabaseUrl: string;
  familyId: string;
  /** Base64 AES-256 key that decrypts the service credentials in Supabase. Never returned by an export. */
  credentialKey: string;
}

export const DEPLOYMENT_CONFIG_KEY = "deployment-config";

const CONFIG_KEYS = new Set(["supabaseUrl", "familyId", "credentialKey"]);

function configObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("The config must be an object.");
  const extra = Object.keys(raw).filter((key) => !CONFIG_KEYS.has(key));
  if (extra.length > 0) throw new Error(`Unknown config keys: ${extra.join(", ")}`);
  return raw as Record<string, unknown>;
}

function projectUrl(value: unknown): string {
  const url = typeof value === "string" ? value.replace(/\/+$/, "") : "";
  if (!/^https:\/\/[^/\s]+$/.test(url)) {
    throw new Error("supabaseUrl must be the https project URL, for example https://<ref>.supabase.co");
  }
  return url;
}

function keyOf(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error("credentialKey must be 32 bytes in base64 (admin new-credential-key).");
  }
  return value;
}

function idOf(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(value)) throw new Error("familyId must be an ID.");
  return value;
}

/** Validates a deployment config. Unknown keys are rejected. */
export function parseDeploymentConfig(raw: unknown): DeploymentConfig {
  const config = configObject(raw);
  return {
    supabaseUrl: projectUrl(config.supabaseUrl),
    familyId: idOf(config.familyId),
    credentialKey: keyOf(config.credentialKey),
  };
}

/** Reads the deployment config. Throws with the fix when it is not set. */
export async function loadDeploymentConfig(storage: KodyStorage): Promise<DeploymentConfig> {
  const stored = await storage.get(DEPLOYMENT_CONFIG_KEY);
  if (stored == null || stored === "") {
    throw new Error("The deployment config is not set. Call the ./configure export with { supabaseUrl, familyId, credentialKey }.");
  }
  return parseDeploymentConfig(typeof stored === "string" ? JSON.parse(stored) : stored);
}

/** What `./configure` returns: the config without the key. */
export type SavedConfig = Omit<DeploymentConfig, "credentialKey"> & { credentialKey: "set" };

/** Validates and saves the deployment config. The result never contains the key. */
export async function saveDeploymentConfig(storage: KodyStorage, raw: unknown): Promise<SavedConfig> {
  const config = parseDeploymentConfig(raw);
  await storage.set(DEPLOYMENT_CONFIG_KEY, JSON.stringify(config));
  return { supabaseUrl: config.supabaseUrl, familyId: config.familyId, credentialKey: "set" };
}

/** Only the entry files of the packages import this module. This is the only file that imports `kody:runtime`. */
export const kodyHost: KodyHost = {
  fetch: (input, init) => fetch(input, init),
  log: (level, message) => console.log(`[${level}] ${message}`),
};

export const kodyStorage = (): KodyStorage => packageStorage();

/** The mount path of the package app (`packageContext.appBasePath` of `kody:runtime`). It is empty outside the app. */
export const kodyAppBasePath = (): string => packageContext?.appBasePath ?? "";
