import { countFetches, createFetchBudget, importCredentialKey } from "@automations/shared";
import { SUPABASE_KEY_PLACEHOLDER, createKodyRuntime, kodyHost, kodyStorage, loadDeploymentConfig } from "@automations/shared/kody";
import { createCredentialResolver, createSupabaseCredentialStore, createSupabaseStorage } from "@automations/librus-data";
import sendMessage from "kody:@tomiwu/telegram/send-message";
import { splitForTelegram, type Messenger } from "../deliver.ts";

export const telegramMessenger: Messenger = {
  async send(chatId, text) {
    for (const part of splitForTelegram(text)) {
      await sendMessage({ chatId, text: part, secretName: "TELEGRAM_BOT_TOKEN", confirm: true });
    }
  },
};

export async function entryDeps() {
  const { supabaseUrl, familyId, credentialKey, fetchReserve } = await loadDeploymentConfig(kodyStorage());
  const counter = countFetches(kodyHost.fetch);
  const supabase = { url: supabaseUrl, key: SUPABASE_KEY_PLACEHOLDER, fetch: counter.fetch };
  const resolve = createCredentialResolver(createSupabaseCredentialStore(supabase), await importCredentialKey(credentialKey), familyId);
  const runtime = createKodyRuntime({ ...kodyHost, fetch: counter.fetch }, resolve);
  const budget = createFetchBudget({ store: kodyStorage(), now: () => new Date() });
  return { runtime, storage: createSupabaseStorage(supabase), familyId, counter, nameStore: kodyStorage(), budget, fetchReserve };
}
