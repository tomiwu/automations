import { importCredentialKey } from "@automations/shared";
import { SUPABASE_KEY_PLACEHOLDER, createKodyRuntime, kodyHost, kodyStorage, loadDeploymentConfig } from "@automations/shared/kody";
import { createCredentialResolver, createSupabaseCredentialStore, createSupabaseStorage } from "@automations/librus-data";
import { splitForTelegram, type Messenger } from "@tomiwu/librus-watch";
import { loadDashboardAllowlist } from "../dashboard-config.ts";
import type { DashboardDeps } from "../dashboard.ts";
import sendMessage from "kody:@tomiwu/telegram/send-message";
import request from "kody:@tomiwu/telegram/request";
import type { TelegramClient } from "../notifier.ts";
import type { UpdateDeps } from "../telegram-update.ts";

export const telegramMessenger: Messenger = {
  async send(chatId, text) {
    for (const part of splitForTelegram(text)) {
      await sendMessage({ chatId, text: part, secretName: "TELEGRAM_BOT_TOKEN", confirm: true });
    }
  },
};

export async function entryDeps() {
  const { supabaseUrl, familyId, credentialKey, paymentPhotos = false } = await loadDeploymentConfig(kodyStorage());
  const supabase = { url: supabaseUrl, key: SUPABASE_KEY_PLACEHOLDER, fetch: kodyHost.fetch };
  const resolve = createCredentialResolver(createSupabaseCredentialStore(supabase), await importCredentialKey(credentialKey), familyId);
  const runtime = createKodyRuntime(kodyHost, resolve);
  return { runtime, storage: createSupabaseStorage(supabase), familyId, paymentPhotos, counters: kodyStorage() };
}

export async function dashboardDeps(): Promise<DashboardDeps> {
  const { storage, familyId } = await entryDeps();
  return { storage, familyId, allowlist: await loadDashboardAllowlist(kodyStorage()), now: () => new Date() };
}

export const telegramClient: TelegramClient = {
  async call(method, params) {
    await request({ method, params, secretName: "TELEGRAM_BOT_TOKEN", confirm: true });
  },
};

export async function updateDeps(): Promise<UpdateDeps> {
  const { runtime, storage, familyId } = await entryDeps();
  return { callback: { familyId, storage, client: telegramClient }, log: (message) => runtime.log("info", message) };
}
