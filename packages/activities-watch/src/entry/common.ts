import { kodyRuntime, kodyStorage, loadDeploymentConfig } from "@automations/shared/kody";
import { supabaseStorageFromRuntime } from "@automations/librus-data";
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
 * The deployment serves one Family. The Supabase URL and the Family ID are plain config in the package storage
 * (set with `./configure`). Only `SUPABASE_KEY` is a secret.
 */
export async function entryDeps() {
  const runtime = kodyRuntime;
  const { supabaseUrl, familyId } = await loadDeploymentConfig(kodyStorage());
  return { runtime, storage: await supabaseStorageFromRuntime(runtime, supabaseUrl), familyId };
}
