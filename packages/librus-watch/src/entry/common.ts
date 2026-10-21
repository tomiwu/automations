import { kodyRuntime } from "@automations/shared/kody";
import { supabaseStorageFromRuntime } from "@automations/librus-data";
import sendMessage from "kody:@tomiwu/telegram/send-message";
import { splitForTelegram, type Messenger } from "../deliver.ts";

/** Sends to Telegram through the external `telegram` package. A long text goes out as several messages. */
export const telegramMessenger: Messenger = {
  async send(chatId, text) {
    for (const part of splitForTelegram(text)) {
      await sendMessage({ chatId, text: part, secretName: "TELEGRAM_BOT_TOKEN", confirm: true });
    }
  },
};

/** The deployment serves one Family. Its ID is in the secret `FAMILY_ID`. */
export async function entryDeps() {
  const runtime = kodyRuntime;
  return { runtime, storage: await supabaseStorageFromRuntime(runtime), familyId: await runtime.secret("FAMILY_ID") };
}
