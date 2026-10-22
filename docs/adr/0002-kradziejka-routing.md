# 0002 kradziejka routes with Jev, threshold 0.6, fallback last bot then Hub

## Status

Accepted.

## Context

One Telegram bot must send each message to the correct Grok bot. A wrong switch in the middle of a conversation is worse than no switch.

## Decision

- The package asks Jev (`POST /v1/decisions`) with one `choice` question.
- The criteria are the active bots, `create_new_bot`, and `hub`.
- The confidence threshold is `0.6`. The owner can change it with `confidenceThreshold` in `./configure`.
- If the confidence is below the threshold, the chat stays with the last bot when that bot is active.
- If there is no active last bot, the message goes to the Hub.
- The Hub ignores active hours.

## Consequences

- A weak answer from Jev does not cause a topic change.
- The package stores the last bot and the last eight messages of each chat.
- The Hub must always exist as an active row.
