import { kodyStorage, saveDeploymentConfig, type SavedConfig } from "@automations/shared/kody";
import { saveDashboardAllowlist, type DashboardUser } from "../dashboard-config.ts";

/**
 * Saves the deployment config of this package: the Supabase project URL, the Family ID and the
 * credential key (base64, from `admin new-credential-key`). Only the owner calls it; never pass the key through an agent.
 * Call it once after the first deploy (and again to rotate the key).
 * The optional `allowlist` is the list of Dashboard users, `{ user, tokenDigest }` with the SHA-256 of the login
 * token in hex. Without it, the saved allowlist stays as it is.
 *
 * @param input - `{ supabaseUrl, familyId, credentialKey, allowlist? }`; unknown keys are rejected.
 * @returns The saved config without the key, and the saved Dashboard users when given.
 *
 * @example
 * import configure from "kody:@tomiwu/payments-watch/configure";
 * await configure({ supabaseUrl: "https://<ref>.supabase.co", familyId: "<family id>", credentialKey: "<base64 key>" });
 */
export default async function configure(input: unknown): Promise<SavedConfig & { allowlist?: string[] }> {
  const { allowlist, ...rest } = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const saved = await saveDeploymentConfig(kodyStorage(), typeof input === "object" && input !== null ? rest : input);
  if (allowlist === undefined) return saved;
  const users: DashboardUser[] = await saveDashboardAllowlist(kodyStorage(), allowlist);
  return { ...saved, allowlist: users.map((entry) => entry.user) };
}
