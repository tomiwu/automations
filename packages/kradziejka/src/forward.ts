import type { FetchFn } from "@automations/shared";
import { assertWebhookUrl } from "./registry.ts";

/** Posts the payload to one routine webhook. The key is the decrypted bot key, not a Kody secret. */
export async function postForward(fetchFn: FetchFn, url: string, key: string, payload: unknown): Promise<void> {
  assertWebhookUrl(url);
  const body = JSON.stringify(payload);
  assertBodySafe(body);
  const response = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body,
  });
  if (!response.ok) throw new Error(`The bot webhook returned ${response.status}.`);
}

/** A Telegram file URL contains the bot token. Do not send one. */
export function assertBodySafe(body: string): void {
  if (body.includes("/file/bot")) throw new Error("Refusing a Telegram file URL.");
}
