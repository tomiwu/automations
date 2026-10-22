# Agent notes: @tomiwu/kradziejka

Routes allowlisted Telegram private chats to Grok bot routine webhooks. Phase 1 is text and photos. Voice stays behind `SpeechToText` in `src/speech.ts`.

## Imports

```ts
import onUpdate from "kody:@tomiwu/kradziejka/telegram-update";
import reply from "kody:@tomiwu/kradziejka/reply";
import registerBot from "kody:@tomiwu/kradziejka/register-bot";
import configure from "kody:@tomiwu/kradziejka/configure";
```

| Export | Input | Output | Side effects |
| --- | --- | --- | --- |
| `./telegram-update` | Webhook envelope or a Telegram update | `{ ok, status }` | Can send Telegram messages and call Jev and a routine webhook |
| `./reply` | `{ chat_id, text }` | `{ ok, chat_id }` | Sends Telegram messages |
| `./register-bot` | Bot fields, including `webhookKey` | `{ ok, slug }` | Encrypts the key and writes `kradziejka_bots` |
| `./configure` | Deployment config | Config without secrets | Writes package storage |
| `./app` | HTTP request | HTML | Reads and writes the registry |

Do not call `./telegram-update` as a live test. It can message a real chat.

## Secrets

`SUPABASE_KEY` and `JEV_API_KEY` are the Kody secrets. Both are literal placeholders (`{{secret:SUPABASE_KEY}}`, `{{secret:JEV_API_KEY}}`). Do not build a secret name at runtime.

This package passes the literal `secretName: "telegramBotToken-kradziejka"` to `@tomiwu/telegram`. That secret is a new BotFather bot. `TELEGRAM_BOT_TOKEN` is the Librus polling bot. Leave that secret unchanged.

Routine webhook keys are ciphertext in `kradziejka_bots`. They are not Kody secrets. Never log, return, or put a key in an example.

## Routing

Jev gets one `choice` question. Criteria are the routable bots plus `create_new_bot` and `hub`. `create_new_bot` is not a row. A confident `create_new_bot` answer is forwarded to the hub with `route.intent` `create_new_bot`.

Confidence below `confidenceThreshold` (default 0.6) keeps the last bot when that bot is routable. Otherwise the message goes to the hub.

The hub row is required. Active hours do not apply to the hub. Other bots use `always`, `HH:MM-HH:MM`, or `D-D HH:MM-HH:MM` in the Family time zone.

## Webhooks

| Name | Mode | Body |
| --- | --- | --- |
| `telegram-update` | `ack`, `url-secret` | Telegram update. Duplicate guard is on `update_id` in package storage. |
| `reply` | `sync`, `params`, `url-secret` | `{ chat_id, text }` only |
| `register` | `sync`, `params`, `url-secret` | Bot fields. Unknown keys are rejected. |

Kody cannot verify `X-Telegram-Bot-Api-Secret-Token`. Security is the secret URL plus the allowlist. The allowlist is config, not code.

The forward payload must not contain `api.telegram.org/file/bot`. Photo objects keep `file_id`, `file_unique_id`, `width`, `height`, and `file_size` only.

## Phase 2

`src/entry/common.ts` sets `speech: noSpeech`. Replace that value with a `SpeechToText` from `src/speech.ts`. Do not download a Telegram file with the bot token in the URL.

## Smoke tests

Run these only after `./configure`, with invented IDs, and only when the owner asks.

1. `./configure` returns `credentialKey: "set"` and `adminToken: "set"`.
2. Open `./app`, sign in, and confirm the hub row is listed. The page must not show a webhook key.
3. `register-bot` with a test slug returns `{ ok: true, slug }`. Confirm the Supabase row ciphertext does not contain the key.
4. Do not send a real Telegram update from an agent.

## Edge cases

- An empty allowlist drops every sender. The drop is silent.
- A group chat is dropped.
- A duplicate `update_id` does not send a second message.
- A missing hub row tells the allowlisted person that the hub is not in the registry.
- A routine URL that is not `https://api2.cursor.sh/automations/webhook/<id>` is rejected.
- Reply `chat_id` must be on the allowlist.
- Voice with `noSpeech` gets one note and is not forwarded.
