import { parseAllowlist } from "./allowlist.ts";
import { DEFAULT_CONFIDENCE } from "./routing.ts";

/** Same storage key as the other packages. This file does not import `kody:runtime`. */
const DEPLOYMENT_CONFIG_KEY = "deployment-config";

interface ConfigStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
}

export interface KradziejkaConfig {
  supabaseUrl: string;
  familyId: string;
  credentialKey: string;
  allowlist: string[];
  adminToken: string;
  confidenceThreshold: number;
}

const KEYS = new Set(["supabaseUrl", "familyId", "credentialKey", "allowlist", "adminToken", "confidenceThreshold"]);

function configObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("The config must be an object.");
  const extra = Object.keys(raw).filter((key) => !KEYS.has(key));
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

function adminTokenOf(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) {
    throw new Error("adminToken must be 16 to 128 letters, digits, _ or -.");
  }
  return value;
}

function thresholdOf(value: unknown): number {
  if (value === undefined) return DEFAULT_CONFIDENCE;
  if (typeof value !== "number" || value <= 0 || value > 1) throw new Error("confidenceThreshold must be a number from 0 exclusive to 1.");
  return value;
}

/** Validates the deployment config. Unknown keys are rejected. */
export function parseKradziejkaConfig(raw: unknown): KradziejkaConfig {
  const config = configObject(raw);
  return {
    supabaseUrl: projectUrl(config.supabaseUrl),
    familyId: idOf(config.familyId),
    credentialKey: keyOf(config.credentialKey),
    allowlist: parseAllowlist(config.allowlist ?? []),
    adminToken: adminTokenOf(config.adminToken),
    confidenceThreshold: thresholdOf(config.confidenceThreshold),
  };
}

/** Reads the deployment config. Throws with the fix when it is not set. */
export async function loadKradziejkaConfig(storage: ConfigStore): Promise<KradziejkaConfig> {
  const stored = await storage.get(DEPLOYMENT_CONFIG_KEY);
  if (stored == null || stored === "") {
    throw new Error("The deployment config is not set. Call the ./configure export with { supabaseUrl, familyId, credentialKey, allowlist, adminToken }.");
  }
  return parseKradziejkaConfig(typeof stored === "string" ? JSON.parse(stored) : stored);
}

export type SavedKradziejkaConfig = Omit<KradziejkaConfig, "credentialKey" | "adminToken"> & {
  credentialKey: "set";
  adminToken: "set";
};

/** Validates and saves the deployment config. The result never contains the key or the admin token. */
export async function saveKradziejkaConfig(storage: ConfigStore, raw: unknown): Promise<SavedKradziejkaConfig> {
  const config = parseKradziejkaConfig(raw);
  await storage.set(DEPLOYMENT_CONFIG_KEY, JSON.stringify(config));
  return {
    supabaseUrl: config.supabaseUrl,
    familyId: config.familyId,
    credentialKey: "set",
    adminToken: "set",
    allowlist: config.allowlist,
    confidenceThreshold: config.confidenceThreshold,
  };
}

/** Replaces the allowlist and keeps the other config fields. */
export async function saveAllowlist(storage: ConfigStore, ids: unknown): Promise<string[]> {
  const current = await loadKradziejkaConfig(storage);
  const allowlist = parseAllowlist(ids);
  await storage.set(DEPLOYMENT_CONFIG_KEY, JSON.stringify({ ...current, allowlist }));
  return allowlist;
}
