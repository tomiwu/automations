# 0003 kradziejka uses its own Telegram bot secret

## Status

Accepted.

## Context

The Librus watcher uses a Telegram bot with long polling (`TELEGRAM_BOT_TOKEN`). Telegram does not allow `getUpdates` while a webhook is set. kradziejka needs a webhook.

## Decision

- kradziejka uses a separate bot from BotFather.
- Its token is the Kody secret `telegramBotToken-kradziejka`. `@tomiwu/telegram` sends it with `secretName`.
- `TELEGRAM_BOT_TOKEN` stays unchanged.

## Consequences

- The webhook of kradziejka does not stop the polling of the Librus watcher.
- A leak of one token does not give access to the other bot.
- The owner creates and approves one more secret.
