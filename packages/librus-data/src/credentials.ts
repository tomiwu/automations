import { decryptCredential, type FetchFn } from "@automations/shared";

/** Reads the encrypted service credentials of a Family. */
export interface CredentialStore {
  /** The ciphertext of one credential, or undefined when it is not set. */
  ciphertext(familyId: string, name: string): Promise<string | undefined>;
}

export interface SupabaseCredentialStoreOptions {
  url: string;
  key: string;
  fetch: FetchFn;
}

/**
 * Reads `credentials` through PostgREST (the watcher role may only select it). The first read of a Family loads all
 * its ciphertexts in one request. Later reads use that answer, so a run makes one request for all credentials.
 */
export function createSupabaseCredentialStore(options: SupabaseCredentialStoreOptions): CredentialStore {
  const base = `${options.url.replace(/\/+$/, "")}/rest/v1/credentials`;
  const loaded = new Map<string, Promise<Map<string, string>>>();

  async function loadAll(familyId: string): Promise<Map<string, string>> {
    const query = `select=name,ciphertext&family_id=eq.${encodeURIComponent(familyId)}`;
    const response = await options.fetch(`${base}?${query}`, {
      method: "GET",
      headers: { apikey: options.key, authorization: `Bearer ${options.key}` },
    });
    if (!response.ok) throw new Error(`Supabase GET credentials failed: ${response.status}`);
    const rows = (await response.json()) as { name?: unknown; ciphertext?: unknown }[];
    const sealed = new Map<string, string>();
    for (const { name, ciphertext } of rows) {
      if (typeof name === "string" && typeof ciphertext === "string") sealed.set(name, ciphertext);
    }
    return sealed;
  }

  return {
    async ciphertext(familyId, name) {
      const pending = loaded.get(familyId) ?? loadAll(familyId);
      loaded.set(familyId, pending);
      pending.catch(() => loaded.delete(familyId));
      return (await pending).get(name);
    },
  };
}

/**
 * Resolves a credential name (for example `accounts.login_secret`) to its value: it reads the ciphertext and
 * decrypts it with the key. Values are cached for the run. A missing credential throws.
 */
export function createCredentialResolver(
  store: CredentialStore,
  key: CryptoKey,
  familyId: string,
): (name: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  const resolve = async (name: string): Promise<string> => {
    const sealed = await store.ciphertext(familyId, name);
    if (sealed === undefined) throw new Error(`Credential ${name} is not set (admin set-credential).`);
    return decryptCredential(key, familyId, name, sealed);
  };
  return (name) => {
    const cached = cache.get(name) ?? resolve(name);
    cache.set(name, cached);
    return cached;
  };
}
