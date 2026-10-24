import { kodyStorage, saveDeploymentConfig, type SavedConfig } from "@automations/shared/kody";

/**
 * Saves the deployment config of this package: the Supabase project URL, the Family ID and the
 * credential key (base64, from `admin new-credential-key`). Only the owner calls it; never pass the key through an agent.
 * Call it once after the first deploy (and again to rotate the key).
 *
 * @param input - `{ supabaseUrl, familyId, credentialKey, activenowCacheHours? }`; unknown keys are rejected. `activenowCacheHours` (default 24) is the time between two ActiveNow fetches of one Account.
 * @returns The saved config without the key.
 *
 * @example
 * import configure from "kody:@tomiwu/activities-watch/configure";
 * await configure({ supabaseUrl: "https://<ref>.supabase.co", familyId: "<family id>", credentialKey: "<base64 key>" });
 */
export default async function configure(input: unknown): Promise<SavedConfig> {
  return saveDeploymentConfig(kodyStorage(), input);
}
