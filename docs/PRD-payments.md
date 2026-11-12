# PRD: payments-watch

## Problem

The owner pays monthly fees for the after-school activities of the Children. Each Organizer has a different account, title, amount and due day. The owner must remember each payment and type each transfer by hand. A payment is easy to forget or to type incorrectly.

The bank (mBank) has no API for private persons. Each transfer needs a confirmation in the bank app. The bank sends no mail for outgoing transfers.

## Goals

1. A new package `packages/payments-watch` finds the Fees that are due for each Child and each Organizer.
2. For each due Fee, the package sends one Notification with a ZBP transfer QR code. The owner scans the QR code in the bank app and confirms the transfer there.
3. The owner marks each Payment as paid or skipped with one button.
4. A reminder goes out when a Payment is not paid and not skipped.
5. A dashboard shows paid and unpaid Payments, the next due dates and the spend per Child.
6. The code has no personal data. All family data is in Supabase.

## Non-goals

- The bot NEVER pays. It never logs in to a bank. It never starts a transfer.
- No bank scraping and no bank API.
- No automatic detection of a paid transfer (the bank sends no mail for outgoing transfers). The button is the only source of the paid status.
- No strict conflict logic between the web page amount and the config amount.
- No Home Assistant adapter in v1. A later adapter can show the QR code on the e-ink screen (reTerminal E1003, wakes about every 30 minutes).
- No new Telegram bot. No change to `TELEGRAM_BOT_TOKEN`.

## Words

- **Organizer**: A company or school that runs an Activity and gets the Fee.
- **Fee**: One recurring charge of one Organizer for one Child. It holds the recipient name, NIP, account, title, due day, notify day and the amount for each month.
- **Payment**: One Fee for one month. Status: `pending`, `paid` or `skipped`.
- **Fee source**: The place where the amount comes from: the web page of the Organizer, or the Fee row (the contract) in Supabase.
- **ZBP QR**: A QR code in the format of the Polish Bank Association recommendation "Standard 2D" (2013).
- **Notifier**: The port that sends one Payment Notification. v1 adapter: Telegram.
- **Dashboard**: A Kody web app that shows the Payments.

All other words (Family, Child, Account, Recipient, Outbox entry, Runtime, StorageAdapter) have the meaning in `docs/PRD.md`.

## Repository layout (new parts)

```
packages/payments-watch            Fee sources, Payment engine, ZBP QR, Telegram notifier, entry files
packages/payments-watch/src/entry  scheduled, configure, callback, dashboard (only these import kody:runtime)
supabase/migrations/0005_payments.sql   tables fees and payments, RLS, grants
docs/adr/0005-payments-qr-not-pay.md    why the bot never pays
```

## Requirements

### Part A: schema (migration `0005_payments.sql`)

1. Table `fees`: `id`, `family_id`, `child_id`, `organizer`, `recipient_name`, `nip` (10 digits or null), `account` (26 digits, NRB), `title`, `due_day` (1-28), `notify_day` (1-28, default 10, less than `due_day`), `reminder_day` (default 14), `amounts` (JSON: month `YYYY-MM` to amount in grosze), `source_url` (null when the config is the only source), `account_id` (null or a link to `accounts`), `enabled`.
2. Table `payments`: `id`, `family_id`, `fee_id`, `month` (`YYYY-MM`), `amount` (grosze), `amount_source` (`page` or `config`), `status` (`pending`, `paid`, `skipped`), `notified_at`, `reminded_at`, `decided_at`, `decided_by` (Recipient chat ID or dashboard user), `created_at`. Unique: `(fee_id, month)`.
3. RLS on as for the other tables. The role `automations_watcher` reads `fees`, and it reads, inserts and updates `payments`. It cannot change `fees`.
4. The SQL tests in `tools/sql-tests` cover the checks, the unique key and the grants.
5. `tools/admin` gets `set-fee` and `list-fees`. `examples/seed.example.json` gets one invented Fee.

### Part B: Fee sources

1. A source interface returns `{ feeId, month, amount, source }` for each Fee and month.
2. Page source: same pattern as `activities-watch` (HTTP and cheerio, login secrets from the `credentials` table through `Runtime`). One parser for each Organizer type. A parser with no amount for a month returns nothing.
3. Config source: the `amounts` of the Fee row.
4. The page amount wins when it exists. Else the config amount is used. If both exist and they are different, the Notification shows both amounts. The QR code uses the page amount. There is no other conflict logic.
5. A failed source gives one failure Notification a day (the same pattern as `activities-watch`). The config amount is still used.

### Part C: Payment engine

1. On `notify_day` (in the Family time zone) or later, before the end of the month, the engine makes one `pending` Payment for each enabled Fee that has an amount for the month. A Payment that exists is not made again.
2. It queues one Notification for each Recipient that has the Child in `child_ids`. The Outbox key is `payment:<payment id>:<chat id>`, so a repeated run does not send twice.
3. On `reminder_day` or later, a `pending` Payment with no `reminded_at` gets one reminder.
4. A `paid` or `skipped` Payment gets no more Notifications.
5. A Fee with amount 0 or no amount for a month makes no Payment.

#### Journal dual write

- The scheduled pass reads the heads of the `payment:` streams once and appends all events in ONE `appendEvents` call: `PaymentDue` or `PaymentChanged` for each pending Payment, and one `CheckCompleted` for each Child with an enabled Fee when the pass did not fail. It also reads the heads of the check streams.
- The projection keeps `upsertPayment` for a new Payment. A changed amount updates `amount` and `amount_source` of a `pending` row (`updatePendingAmount`). The pass never changes `fees`.
- After the delivery, each pending Payment that got its first Notification or its reminder gets a `PaymentChanged` with `notifiedAt` or `remindedAt` and the same amount. The projection gets `notified_at` or `reminded_at` (`markPaymentSent`).
- The journal never holds QR text, bank account, NIP, title, recipient name or source URL. The QR text is built in the Notifier at send time only.
- The Outbox keys stay the same, so a repeated pass sends nothing twice.

### Part D: ZBP QR

1. Content: `NIP|PL|NRB|AMOUNT|RECIPIENT|TITLE|||`.
2. NIP: 10 digits or empty. Country: `PL`. NRB: 26 digits, no spaces, no `PL`. Amount: grosze, at least 6 digits, with leading zeros.
3. Recipient: max 20 characters. Title: max 32 characters. Longer text is truncated. Characters that are not in the allowed set of the standard are replaced or removed.
4. The full text has max 160 characters. QR settings: UTF-8, error correction L, a border of 4 modules.
5. Validation rejects a bad NRB (checksum), a bad NIP (checksum) and an amount of 0.
6. The output is a PNG image and the content text.

### Part E: Notifier

1. Port `Notifier.sendPayment(recipient, payment, qr)`. Watcher code knows only the port.
2. v1 adapter: Telegram, with the existing bot, the secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID`, and the package `@tomiwu/telegram`. The message is a photo (the QR code) with a caption (Child, Organizer, month, amount, due date, amount source) and two inline buttons: `Paid` and `Skip`.
3. The callback data is `pay:<payment id>:paid` or `pay:<payment id>:skip`. The existing `telegram` webhook of `librus-watch` routes `pay:` callbacks to `payments-watch`. Only a Recipient of the Child can change a Payment.
4. After a button press, the bot edits the message to show the new status and removes the buttons.
5. The text comes from the pl/en catalogs in the language of the Recipient.
6. Later adapter (not v1): a Home Assistant sensor that the e-ink screen reads when it wakes.

### Part F: Dashboard

1. A Kody web app in `payments-watch`. It reads Supabase.
2. Views: paid and unpaid Payments; next due Payments (date, amount); spend per Child per month and per school year (September to June).
3. A `Paid` and a `Skip` button on each `pending` Payment.
4. Access only after login, for an allowlist of users (the owner and one more adult). The allowlist is in the deployment config, not in the code.

### Part G: deploy on Kody

1. `package.json` `kody.jobs`: `scheduled-check` once a day (for example `0 8 * * *`). Kody reads the cron in UTC, not in the Family time zone.
2. `./configure` takes `{ supabaseUrl, familyId, credentialKey }`. The dashboard also needs `allowlist`.
3. The CI deploy workflow stages and checks the new package as for the other packages.

## Prerequisites

1. `SUPABASE_KEY` on Kody is not valid now. All Kody jobs fail with `401 Invalid API key`. The owner must set a new watcher key before any deploy.
2. Coordinate with the Librus Szkola agent. It leads the refactor and parses the family config into Supabase. It loads the Fee rows.

## Code factory

As in `docs/PRD.md`: Sandcastle loop, one branch and PR for each issue, squash merge only when all CI checks pass. Issues have the label `Sandcastle`, a priority label and "Blocked by #N" lines.

## Risks

- An incorrect account number in a Fee row sends money to the wrong account. Mitigation: NRB checksum, the caption shows the recipient name, and the owner checks the transfer in the bank app before confirmation.
- Organizer pages change. Mitigation: the config fallback and the failure Notification.
- A bank app can read Polish characters incorrectly. Mitigation: a test QR code scanned by the owner before the first real use.
- The paid status depends on the owner pressing a button. Mitigation: the reminder and the dashboard.
- Personal data in code. Mitigation: placeholders only, the CI deny-list check and gitleaks.
