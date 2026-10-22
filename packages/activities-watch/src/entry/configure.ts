import { kodyStorage, saveDeploymentConfig, type DeploymentConfig } from "@automations/shared/kody";

/**
 * Saves the plain deployment config of this package: the Supabase project URL and the Family ID.
 * Call it once after the first deploy (and again to change it). It holds no secret.
 *
 * @param input - `{ supabaseUrl, familyId }`; unknown keys are rejected.
 * @returns The saved config.
 *
 * @example
 * import configure from "kody:@tomiwu/activities-watch/configure";
 * await configure({ supabaseUrl: "https://<ref>.supabase.co", familyId: "<family id>" });
 */
export default async function configure(input: unknown): Promise<DeploymentConfig> {
  return saveDeploymentConfig(kodyStorage(), input);
}
