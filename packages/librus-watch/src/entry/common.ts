import { countFetches, createFetchBudget, importCredentialKey } from "@automations/shared";
import { SUPABASE_KEY_PLACEHOLDER, createKodyRuntime, kodyHost, kodyStorage, loadDeploymentConfig } from "@automations/shared/kody";
import { createCredentialResolver, createSupabaseCredentialStore, createSupabaseStorage } from "@automations/librus-data";
import sendMessage from "kody:@tomiwu/telegram/send-message";
import sendDocument from "kody:@tomiwu/telegram/send-document";
import { splitForTelegram, type Messenger } from "../deliver.ts";

/** Sends to Telegram through the external `telegram` package. A long text goes out as several messages. */
export const telegramMessenger: Messenger = {
  async send(chatId, text) {
    for (const part of splitForTelegram(text)) {
      await sendMessage({ chatId, text: part, secretName: "TELEGRAM_BOT_TOKEN", confirm: true });
    }
  },
  async sendDocument(chatId, fileName, document, caption) {
    await sendDocument({ chatId, fileName, document, caption, secretName: "TELEGRAM_BOT_TOKEN", confirm: true });
  },
};

/**
 * The deployment serves one Family. The Supabase URL, the Family ID and the credential key are config in the
 * package storage (set with `./configure`). `SUPABASE_KEY` is the only Kody secret. The service logins are
 * encrypted rows in Supabase; `runtime.secret(name)` decrypts them. `counter` counts the fetches of Supabase and
 * Librus. `budget` keeps the weekly count of the package (see `fetch-budget.ts` of `@automations/shared`). The Telegram sends go through the `telegram` package and are not in the count.
 */
export async function entryDeps() {
  const { supabaseUrl, familyId, credentialKey, fetchReserve } = await loadDeploymentConfig(kodyStorage());
  const counter = countFetches(kodyHost.fetch);
  const supabase = { url: supabaseUrl, key: SUPABASE_KEY_PLACEHOLDER, fetch: counter.fetch };
  const resolve = createCredentialResolver(createSupabaseCredentialStore(supabase), await importCredentialKey(credentialKey), familyId);
  const runtime = createKodyRuntime({ ...kodyHost, fetch: counter.fetch }, resolve);
  const budget = createFetchBudget({ store: kodyStorage(), now: () => new Date() });
  return { runtime, storage: createSupabaseStorage(supabase), familyId, counter, nameStore: kodyStorage(), budget, fetchReserve };
}
