import { countFetches, createFetchBudget, importCredentialKey } from "@automations/shared";
import { SUPABASE_KEY_PLACEHOLDER, createKodyRuntime, kodyHost, kodyStorage, loadDeploymentConfig } from "@automations/shared/kody";
import { createCredentialResolver, createSupabaseCredentialStore, createSupabaseStorage } from "@automations/librus-data";
import { splitForTelegram, type Messenger } from "@tomiwu/librus-watch";
import sendMessage from "kody:@tomiwu/telegram/send-message";

/** Sends to Telegram through the external `telegram` package. A long text goes out as several messages. */
export const telegramMessenger: Messenger = {
  async send(chatId, text) {
    for (const part of splitForTelegram(text)) {
      await sendMessage({ chatId, text: part, secretName: "TELEGRAM_BOT_TOKEN", confirm: true });
    }
  },
};

/**
 * The deployment serves one Family. The Supabase URL, the Family ID and the credential key are config in the
 * package storage (set with `./configure`). `SUPABASE_KEY` is the only Kody secret. The service logins are
 * encrypted rows in Supabase; `runtime.secret(name)` decrypts them.
 */
export async function entryDeps() {
  const { supabaseUrl, familyId, credentialKey, activenowCacheHours, fetchReserve } = await loadDeploymentConfig(kodyStorage());
  const counter = countFetches(kodyHost.fetch);
  const supabase = { url: supabaseUrl, key: SUPABASE_KEY_PLACEHOLDER, fetch: counter.fetch };
  const resolve = createCredentialResolver(createSupabaseCredentialStore(supabase), await importCredentialKey(credentialKey), familyId);
  const runtime = createKodyRuntime({ ...kodyHost, fetch: counter.fetch }, resolve);
  const activeNow = { store: kodyStorage(), ...(activenowCacheHours === undefined ? {} : { ttlMs: activenowCacheHours * 3_600_000 }) };
  const budget = createFetchBudget({ store: kodyStorage(), now: () => new Date() });
  return { runtime, storage: createSupabaseStorage(supabase), familyId, activeNow, counter, budget, fetchReserve };
}
