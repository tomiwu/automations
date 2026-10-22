import { importCredentialKey } from "@automations/shared";
import { SUPABASE_KEY_PLACEHOLDER, kodyHost, kodyStorage } from "@automations/shared/kody";
import sendMessage from "kody:@tomiwu/telegram/send-message";
import request from "kody:@tomiwu/telegram/request";
import type { AdminDeps } from "../admin.ts";
import { splitText } from "../clip.ts";
import { loadKradziejkaConfig, saveAllowlist } from "../config.ts";
import { postForward } from "../forward.ts";
import type { HandlerDeps, TelegramPort } from "../handle.ts";
import { postDecision } from "../jev.ts";
import { openWebhookKey, sealWebhookKey } from "../registry-crypto.ts";
import { createSupabaseRegistry } from "../registry.ts";
import type { ReplyDeps } from "../reply.ts";
import type { RegisterDeps } from "../register.ts";
import { noSpeech } from "../speech.ts";

/** Sends through the external telegram package. `TELEGRAM_BOT_TOKEN` is that package's secret. */
export const telegramPort: TelegramPort = {
  async typing(chatId) {
    await request({
      method: "sendChatAction",
      params: { chat_id: chatId, action: "typing" },
      secretName: "TELEGRAM_BOT_TOKEN",
      confirm: true,
    });
  },
  async send(chatId, body) {
    for (const part of splitText(body)) {
      await sendMessage({ chatId, text: part, secretName: "TELEGRAM_BOT_TOKEN", confirm: true });
    }
  },
};

async function opened() {
  const config = await loadKradziejkaConfig(kodyStorage());
  const registry = createSupabaseRegistry({
    url: config.supabaseUrl,
    key: SUPABASE_KEY_PLACEHOLDER,
    fetch: kodyHost.fetch,
  });
  return { config, registry, cryptoKey: await importCredentialKey(config.credentialKey) };
}

/** Dependencies for the Telegram webhook. Phase 2 replaces `noSpeech` in this function. */
export async function handlerDeps(): Promise<HandlerDeps> {
  const { config, registry, cryptoKey } = await opened();
  return {
    familyId: config.familyId,
    allowlist: config.allowlist,
    threshold: config.confidenceThreshold,
    timezone: await registry.timezone(config.familyId),
    kv: kodyStorage(),
    registry,
    telegram: telegramPort,
    // Phase 2: replace noSpeech with a SpeechToText implementation. Do not pass Telegram file URLs.
    speech: noSpeech,
    now: () => new Date(),
    decide: (body) => postDecision(kodyHost.fetch, body),
    forward: (url, key, payload) => postForward(kodyHost.fetch, url, key, payload),
    openKey: (slug, ciphertext) => openWebhookKey(cryptoKey, config.familyId, slug, ciphertext),
  };
}

/** Dependencies for register-bot. The seal function encrypts the webhook key. */
export async function registerDeps(): Promise<RegisterDeps> {
  const { config, registry, cryptoKey } = await opened();
  return {
    familyId: config.familyId,
    registry,
    seal: (slug, webhookKey) => sealWebhookKey(cryptoKey, config.familyId, slug, webhookKey),
  };
}

/** Dependencies for the reply webhook. */
export async function replyDeps(): Promise<ReplyDeps> {
  const { config } = await opened();
  return { allowlist: config.allowlist, kv: kodyStorage(), telegram: telegramPort, now: () => new Date() };
}

/** Dependencies for the admin app. */
export async function adminDeps(): Promise<AdminDeps> {
  const deps = await registerDeps();
  const { config } = await opened();
  return {
    ...deps,
    adminToken: config.adminToken,
    allowlist: config.allowlist,
    saveAllowlist: (ids) => saveAllowlist(kodyStorage(), ids),
  };
}
