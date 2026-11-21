export const NAME_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface NameStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
}

export interface NameCacheOptions {
  store: NameStore;
  key: string;
  ttlMs?: number;
}

export interface NameCache {
  find(name: string): Promise<string | undefined>;
  save(name: string, value: string): Promise<void>;
  flush(): Promise<void>;
}

export const nameCacheKey = (accountId: string): string => `librus-names:${accountId}`;

export const nameOptionsFor = (store: NameStore | undefined, accountId: string): NameCacheOptions | undefined =>
  store && { store, key: nameCacheKey(accountId) };

type Entries = Record<string, { name: string; at: number }>;

function parseEntries(stored: unknown): Entries {
  const value = typeof stored === "string" ? (JSON.parse(stored) as unknown) : stored;
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Entries) : {};
}

async function readEntries(options: NameCacheOptions): Promise<Entries> {
  try {
    const stored = await options.store.get(options.key);
    return stored == null || stored === "" ? {} : parseEntries(stored);
  } catch {
    return {};
  }
}

export function createNameCache(options: NameCacheOptions, now: () => Date): NameCache {
  const ttlMs = options.ttlMs ?? NAME_CACHE_TTL_MS;
  const fresh = (entry: Entries[string] | undefined): entry is Entries[string] =>
    typeof entry?.name === "string" && now().getTime() - entry.at < ttlMs;
  let loaded: Promise<Entries> | undefined;
  let dirty = false;
  const entries = (): Promise<Entries> => (loaded ??= readEntries(options));
  return {
    async find(name) {
      const entry = (await entries())[name];
      return fresh(entry) ? entry.name : undefined;
    },
    async save(name, value) {
      (await entries())[name] = { name: value, at: now().getTime() };
      dirty = true;
    },
    async flush() {
      if (!dirty) return;
      const all = await entries();
      for (const name of Object.keys(all)) if (!fresh(all[name])) delete all[name];
      dirty = false;
      await options.store.set(options.key, JSON.stringify(all)).catch(() => undefined);
    },
  };
}
