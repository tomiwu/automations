import { packageContext, packageStorage } from "kody:runtime";
import type { FetchFn, LogLevel, Runtime } from "./runtime.ts";

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

export const SUPABASE_KEY_PLACEHOLDER = "{{secret:SUPABASE_KEY}}";

export interface KodyStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
}

export interface KodyHost {
  fetch: FetchFn;
  log(level: LogLevel, message: string): void;
}

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

export interface DeploymentConfig {
  supabaseUrl: string;
  familyId: string;
  /** Base64 AES-256 key that decrypts the service credentials in Supabase. Never returned by an export. */
  credentialKey: string;
  activenowCacheHours?: number;
  /** payments-watch: send the Payment Notifications and reminders as QR photos with Paid and Skip. Optional; default false (text). */
  paymentPhotos?: boolean;
  fetchReserve?: number;
}

export const DEPLOYMENT_CONFIG_KEY = "deployment-config";

const CONFIG_KEYS = new Set(["supabaseUrl", "familyId", "credentialKey", "activenowCacheHours", "fetchReserve", "paymentPhotos"]);

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

const MAX_CACHE_HOURS = 720;

function hoursOf(value: unknown): { activenowCacheHours?: number } {
  if (value === undefined) return {};
  const valid = typeof value === "number" && value > 0 && value <= MAX_CACHE_HOURS;
  if (!valid) {
    throw new Error("activenowCacheHours must be a number of hours above 0 and at most 720.");
  }
  return { activenowCacheHours: value };
}

const MAX_RESERVE = 2500;

function reserveOf(value: unknown): { fetchReserve?: number } {
  if (value === undefined) return {};
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_RESERVE) {
    throw new Error("fetchReserve must be a whole number of fetches from 0 to 2500.");
  }
  return { fetchReserve: value as number };
}

function photosOf(value: unknown): { paymentPhotos?: boolean } {
  if (value === undefined) return {};
  if (typeof value !== "boolean") throw new Error("paymentPhotos must be true or false.");
  return { paymentPhotos: value };
}

/** Validates a deployment config. Unknown keys are rejected. */
export function parseDeploymentConfig(raw: unknown): DeploymentConfig {
  const config = configObject(raw);
  return {
    supabaseUrl: projectUrl(config.supabaseUrl),
    familyId: idOf(config.familyId),
    credentialKey: keyOf(config.credentialKey),
    ...hoursOf(config.activenowCacheHours),
    ...photosOf(config.paymentPhotos),
    ...reserveOf(config.fetchReserve),
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

export type SavedConfig = Omit<DeploymentConfig, "credentialKey"> & { credentialKey: "set" };

/** Validates and saves the deployment config. The result never contains the key. */
export async function saveDeploymentConfig(storage: KodyStorage, raw: unknown): Promise<SavedConfig> {
  const config = parseDeploymentConfig(raw);
  await storage.set(DEPLOYMENT_CONFIG_KEY, JSON.stringify(config));
  return { supabaseUrl: config.supabaseUrl, familyId: config.familyId, credentialKey: "set" };
}

export const kodyHost: KodyHost = {
  fetch: (input, init) => fetch(input, init),
  log: (level, message) => console.log(`[${level}] ${message}`),
};

export const kodyStorage = (): KodyStorage => packageStorage();

/** The mount path of the package app (`packageContext.appBasePath` of `kody:runtime`). It is empty outside the app. */
export const kodyAppBasePath = (): string => packageContext?.appBasePath ?? "";
