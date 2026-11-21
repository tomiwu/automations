import { importCredentialKey } from "@automations/shared";
import { SUPABASE_KEY_PLACEHOLDER, createKodyRuntime, kodyHost, kodyStorage, loadDeploymentConfig, type KodyHost } from "@automations/shared/kody";
import { createCredentialResolver, createSupabaseCredentialStore, createSupabaseStorage } from "@automations/librus-data";
import { splitForTelegram, type Messenger } from "@tomiwu/librus-watch";
import { loadDashboardAllowlist } from "../dashboard-config.ts";
import type { DashboardDeps } from "../dashboard.ts";
import sendMessage from "kody:@tomiwu/telegram/send-message";
import request from "kody:@tomiwu/telegram/request";
import type { TelegramClient } from "../notifier.ts";
import type { UpdateDeps } from "../telegram-update.ts";

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
 * `host` lets an export count every fetch (Supabase, credentials and the services) with one counter.
 */
export async function entryDeps(host: KodyHost = kodyHost) {
  const { supabaseUrl, familyId, credentialKey, paymentPhotos = false } = await loadDeploymentConfig(kodyStorage());
  const supabase = { url: supabaseUrl, key: SUPABASE_KEY_PLACEHOLDER, fetch: host.fetch };
  const resolve = createCredentialResolver(createSupabaseCredentialStore(supabase), await importCredentialKey(credentialKey), familyId);
  const runtime = createKodyRuntime(host, resolve);
  return { runtime, storage: createSupabaseStorage(supabase), familyId, paymentPhotos, counters: kodyStorage() };
}

/** Dependencies for the Dashboard app: the storage, the Family and the allowlist from the package storage. */
export async function dashboardDeps(): Promise<DashboardDeps> {
  const { storage, familyId } = await entryDeps();
  return { storage, familyId, allowlist: await loadDashboardAllowlist(kodyStorage()), now: () => new Date() };
}

/** Calls the bot API through the external `telegram` package. The token stays in the Kody secret. */
export const telegramClient: TelegramClient = {
  async call(method, params) {
    await request({ method, params, secretName: "TELEGRAM_BOT_TOKEN", confirm: true });
  },
};

/** Dependencies for the `telegram-update` webhook. */
export async function updateDeps(): Promise<UpdateDeps> {
  const { runtime, storage, familyId } = await entryDeps();
  return { callback: { familyId, storage, client: telegramClient }, log: (message) => runtime.log("info", message) };
}
