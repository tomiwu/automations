import { kodyStorage } from "@automations/shared/kody";
import { saveKradziejkaConfig, type SavedKradziejkaConfig } from "../config.ts";

/**
 * Saves the deployment config. Only the owner calls it. Do not pass the keys through an agent.
 * Call it once after the first deploy, and again when you rotate a key or change the allowlist.
 *
 * @param input - `{ supabaseUrl, familyId, credentialKey, allowlist, adminToken, confidenceThreshold? }`. Unknown keys are rejected.
 * @returns The saved config. The credential key and the admin token are not in the result.
 *
 * @example
 * import configure from "kody:@tomiwu/kradziejka/configure";
 * await configure({
 *   supabaseUrl: "https://example.supabase.co",
 *   familyId: "00000000-0000-4000-8000-000000000001",
 *   credentialKey: "<base64 key>",
 *   allowlist: ["1000001"],
 *   adminToken: "example-admin-token",
 *   confidenceThreshold: 0.6,
 * });
 */
export default async function configure(input: unknown): Promise<SavedKradziejkaConfig> {
  return saveKradziejkaConfig(kodyStorage(), input);
}
