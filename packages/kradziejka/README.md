# @tomiwu/kradziejka

One Telegram bot routes allowlisted people to selected Grok bot routines.

## Intent

A person sends a text or a photo to one Telegram bot. The package chooses a Grok bot and forwards the message to that bot's routine webhook. The Grok bot sends the reply back through a second webhook, and this package delivers it on Telegram. The hub bot can register a new bot after it creates one. Voice is phase 2. Phase 1 does not transcribe speech.

## How it works

1. Telegram calls the `telegram-update` webhook (`responseMode: ack`, `verification: url-secret`).
2. The package ignores a repeated `update_id`. Kody replay protection reads a header. Telegram puts `update_id` in the JSON body, so the guard is in the package.
3. A sender who is not on the allowlist gets no reply. The chat must be a private chat.
4. The package calls `sendChatAction` with `typing`, then sends "One moment." It uses `@tomiwu/telegram`.
5. The package asks Jev (`POST https://api.getjevai.com/v1/decisions`) with the current message, the last messages of this chat, and the last bot. There is one `choice` question. The criteria are the active bots, plus `create_new_bot`, plus `hub`.
6. Confidence below the threshold is not a clear topic change. The chat stays with the last bot when that bot is still active. Otherwise the message goes to the hub.
7. The package POSTs JSON to `https://api2.cursor.sh/automations/webhook/<id>` with `Authorization: Bearer <key>`. The JSON has `chat_id`, `from`, `text`, photo fields, recent turns, and reply instructions. It never has a Telegram file URL. Those URLs contain the bot token.
8. The Grok bot POSTs `{ "chat_id", "text" }` to the `reply` webhook. The package sends that text to the chat.
9. The hub POSTs a new bot to the `register` webhook. The package encrypts the webhook key and stores the row.

Active hours use the Family time zone. The forms are `always`, `HH:MM-HH:MM`, and `D-D HH:MM-HH:MM` (1 = Monday, 7 = Sunday). The hub ignores active hours.

Chat memory (last bot and the last eight messages) is in package storage.

## Phase 2

Replace `noSpeech` in `src/entry/common.ts` with a `SpeechToText` implementation (`src/speech.ts`). The handler already forwards a transcript as text. Do not put a Telegram file URL in that implementation.

## Manual setup

Do these steps on your own computer. Do not give tokens or keys to an agent. Do not put them in the repository.

### 1. Supabase

Apply `supabase/migrations/0003_kradziejka.sql` with the other migrations (`docs/supabase-setup.md`). The role `automations_watcher` can read, insert, and update `kradziejka_bots`. It cannot delete rows.

### 2. BotFather

1. In Telegram, open `@BotFather`.
2. Send `/newbot`.
3. Set a display name and a username that ends with `bot`.
4. Copy the token into a password manager.

### 3. Kody secrets

Create these secrets in Kody. Approve each host. Do not change other secrets.

| Secret | Value | Host | Placement |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | The BotFather token | `api.telegram.org` | The `telegram` package sends it. |
| `SUPABASE_KEY` | The `automations_watcher` key | `<ref>.supabase.co` | Header |
| `JEV_API_KEY` | A key from [getjevai.com](https://www.getjevai.com/) | `api.getjevai.com` | Header (`Authorization`) |

`JEV_API_KEY` must be the literal secret name. The code sends `Bearer {{secret:JEV_API_KEY}}`.

Install `@tomiwu/telegram` in the same Kody account before the first deploy.

Bot webhook keys are not Kody secrets. Enter them in the admin page in step 8. The package stores AES-256-GCM ciphertext, in the same format as the `credentials` table.

### 4. Deploy

The workflow `.github/workflows/deploy-kody.yml` includes `kradziejka`. A dry run stages the package and runs `packageCheck`. It saves nothing.

Leave the repository variable `KODY_DEPLOY_ENABLED` unset or not `true` until you want a real deploy. This package does not publish itself.

After a real publish, approve the package for `SUPABASE_KEY` and `JEV_API_KEY` if Kody shows `pending_secret_package_approvals`. Approve the webhook enablement when mint returns `approval_url`.

### 5. Configure

Call `./configure` once. Unknown keys are rejected. The result does not contain `credentialKey` or `adminToken`.

```ts
import configure from "kody:@tomiwu/kradziejka/configure";

await configure({
  supabaseUrl: "https://<ref>.supabase.co",
  familyId: "<family id>",
  credentialKey: "<base64 key from admin new-credential-key>",
  allowlist: ["<telegram user id>"],
  adminToken: "<16 or more letters, digits, _ or ->",
  confidenceThreshold: 0.6,
});
```

`allowlist` is the Telegram user IDs that may talk to the bot. An empty list accepts no one. Do not hard-code the IDs in the repository. To read an ID, the person can open `@userinfobot` and send `/start`, or you can call `getUpdates` before you set the webhook. `getUpdates` fails while a webhook is set.

`confidenceThreshold` is optional. The default is `0.6`.

### 6. Mint the webhooks and call setWebhook

In the package settings (`/@<username>/kradziejka/settings`, Webhooks), mint and approve:

| Name | Use |
| --- | --- |
| `telegram-update` | Telegram `setWebhook` |
| `reply` | Each Grok routine, so it can answer |
| `register` | The hub routine, so it can add a bot |

Kody cannot check the header `X-Telegram-Bot-Api-Secret-Token`. Do not set `secret_token`. The secret is the URL.

On your computer:

```sh
curl -sS -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url":"<minted telegram-update URL>"}'
```

Confirm with `getWebhookInfo`. The URL must be the minted `telegram-update` URL.

### 7. Routine keys

In each Cursor routine, create a webhook. Copy the URL (`https://api2.cursor.sh/automations/webhook/<id>`) and the key into a password manager.

Put this text in the routine instructions, with the minted reply URL:

```text
When you finish, POST JSON {"chat_id":"<chat_id from the input>","text":"<your reply>"} to <minted reply URL>.
Use the chat_id from the input. Do not call the Telegram Bot API.
```

### 8. Admin page and the hub row

Open the package app and sign in with `adminToken`.

Add a hub row first:

| Field | Value |
| --- | --- |
| Slug | `hub` |
| Name | Hub |
| Description | What the hub handles, in one or two sentences. |
| Active hours | `always` |
| Webhook URL | The hub routine URL from step 7. |
| Webhook key | The hub routine key. |

Add one row for each other bot. Leave the key empty on a later save to keep the stored key. The page does not show the key. To stop a bot, clear Active. The slug `create_new_bot` is reserved.

You can also edit the allowlist on this page.

### 9. Hub registration

When the hub creates a new routine, it POSTs to the minted `register` URL:

```json
{
  "slug": "grades",
  "name": "Grades",
  "description": "Questions about grades.",
  "webhookUrl": "https://api2.cursor.sh/automations/webhook/<id>",
  "webhookKey": "<routine key>",
  "activeHours": "always",
  "active": true
}
```

The response is `{ "ok": true, "slug": "grades" }`. It does not contain the key.

### 10. Check

1. From an allowlisted account, send a text. You get "One moment." Then the chosen bot replies.
2. Send a photo. The routine payload has `file_id`, width, and height. It has no `api.telegram.org` URL.
3. From another account, send a text. You get no reply.
4. Send a voice message. You get a note that voice is not available yet.
