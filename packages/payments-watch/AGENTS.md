# Agent notes: @tomiwu/payments-watch

Builds ZBP payment QR codes for the Fees of the Organizers and sends them to the Recipients on Telegram with Paid and Skip buttons.

## Imports

```ts
import scheduled from "kody:@tomiwu/payments-watch/scheduled";
import onUpdate from "kody:@tomiwu/payments-watch/telegram-update";
import configure from "kody:@tomiwu/payments-watch/configure";
```

| Export | Input | Output | Side effects |
| --- | --- | --- | --- |
| `./scheduled` | Job event | Run summary | Reads Fees, writes Payments, sends Telegram photos |
| `./telegram-update` | Webhook envelope or a Telegram update | `{ ok }` | Records Paid or Skip, edits the Telegram message |
| `./configure` | Deployment config | Config without secrets | Writes package storage |
| `./stored-payments` | `{ childId?, month? }` | `{ timezone, month, lastSavedAt, payments, fetches }`. Each Payment has `childId` (the Journal `child_id`) | None. Reads Supabase only |
| `./activenow-ledger` | `{ monthsBack? }` | `{ today, from, accounts, fees, fetches? }`. Settlements rows per enabled ActiveNow Account plus every Fee row | None. Read-only |
| `./app` | HTTP request | HTML dashboard | Reads and writes Payments |

Do not call `./scheduled` or `./telegram-update` as a live test. They can message a real chat.

## Secrets

`SUPABASE_KEY` is the only Kody secret, used as the literal placeholder `{{secret:SUPABASE_KEY}}`. Telegram messages use the literal secret name `TELEGRAM_BOT_TOKEN`. Do not change secrets. Never log or return a secret.
