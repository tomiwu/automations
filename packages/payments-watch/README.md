# @tomiwu/payments-watch

Builds ZBP payment QR codes for the Fees of the Organizers. The bot never pays (see ADR 0005).

## How it works

- `buildZbpText` makes the content `NIP|PL|NRB|AMOUNT|RECIPIENT|TITLE|||`.
- The NIP is 10 digits or empty. The NRB has 26 digits. Both need a correct checksum.
- The amount is in grosze, with at least 6 digits and leading zeros. An amount of 0 is rejected.
- The recipient is cut to 20 characters. The title is cut to 32 characters. A character that is not allowed becomes a space.
- The full text has 160 characters or less.
- `buildZbpQr` gives `{ text, png }`. The PNG uses UTF-8, error correction L and a border of 4 modules.

## Fee sources

- A `FeeSource` has `amountFor(fee, month)`. It gives `{ feeId, month, amount, source }` or `undefined`.
- `createConfigFeeSource` gives the `amounts` value of the Fee for the month, with `source: "config"`. It gives `undefined` when the month has no amount. The engine ignores an amount of 0.

- `parseOrganizerAmount(html, month)` reads the amount in grosze from the fee table of an Organizer page (`table.fees`, one `tr[data-month="YYYY-MM"]` with a `.amount` cell). It gives `undefined` for a month with no amount. It throws when the page has no fee table.
- `createWebFeeSource` is the page source. A Fee with a `sourceUrl` gets one GET of that page with `Runtime.fetch`. The page amount wins (`source: "page"`). When the config has a different amount, it stays in `configAmount`.
- `parseFeePage(type, html, month)` has one parser for each Organizer type: `activenow` (`.an-fees`), `edusky` (`table.edusky-charges`), `mondo` (`.mondo-fees`) and `plain` (`table.fees`, the same as `parseOrganizerAmount`). Each gives grosze, or `undefined` for a month with no amount. Each throws when its fee list is not in the page.
- `organizerTypeOf(url)` picks the type from the host name of the `sourceUrl` (`activenow`, `edusky` or `mondo` in the name). Other hosts are `plain`. An Organizer with no fees on its page has no `sourceUrl` and uses the config only.
- A Fee without a `sourceUrl`, a page without the month, or a failed page gives the config amount. A failed page also queues one failure Notification a day for each Recipient of the Child (`failure:<fee id>:<day>:<chat id>`).
- `./scheduled` uses the page source.

## Payment engine

- `runPayments` reads the Family config, the Fees and a `FeeSource`. It uses the day and month in the Family time zone.
- On `notifyDay` or later, an enabled Fee with an amount above 0 gets one `pending` Payment for the month. An existing Payment is not made again.
- Each Recipient of the Child gets one Outbox entry with the key `payment:<payment id>:<chat id>`.
- On `reminderDay` or later, a `pending` Payment gets one reminder with the key `payment:<payment id>:<chat id>:reminder`.
- A `paid` or `skipped` Payment gets no Notification. A repeated run queues nothing twice.

## Notifier

- The port `Notifier.sendPayment(recipient, notice, qr)` takes the Recipient, a `PaymentNotice` (`child`, `fee`, `payment`) and the QR code.
- `createTelegramNotifier` is the v1 adapter. It calls `sendPhoto` with the QR PNG, a caption and two inline buttons.
- The callback data is `pay:<payment id>:paid` and `pay:<payment id>:skip`.
- The caption and the button names come from the pl/en catalogs in the language of the Recipient. The caption shows the Child, the Organizer, the month, the amount, the due date and the amount source.
- When the Payment amount comes from the page and the config has a different amount for the month, the caption shows both amounts.
- `createTelegramHttpClient(fetch, token)` is a `TelegramClient` that posts to the bot API. The token is the existing `TELEGRAM_BOT_TOKEN`. No new secret is needed.

## Callback

- `handlePaymentCallback(deps, query)` handles a button press with the data `pay:<payment id>:paid` or `pay:<payment id>:skip`. It gives `false` for other data.
- Only a Recipient of the Child of the Fee can change the Payment. Another chat gets an error answer and the Payment stays as it is.
- The first press sets the status and `decidedBy` (the chat ID), answers the press, edits the caption with the new status and removes the buttons.
- A second press changes nothing. The chat gets an error answer.
- The texts come from the pl/en catalogs. A chat that is not a Recipient gets the default language of the Family.

## Entry files and Kody job

- `runPaymentsWatch` runs the Payment engine with a `FeeSource`, then delivers the Outbox to the Recipients. It gives the failure texts.
- `./scheduled` (`src/entry/scheduled.ts`) is the job `scheduled-check`. It runs once a day at 08:00. The time zone of the schedule must be the time zone of the Family. It takes no input and rejects when a step failed.
- `./configure` (`src/entry/configure.ts`) takes `{ supabaseUrl, familyId, credentialKey }`. Only the owner calls it.
- Only the entry files import the Kody runtime. The only Kody secret is `SUPABASE_KEY`. The delivery uses `TELEGRAM_BOT_TOKEN` through `@tomiwu/telegram`.

## Dashboard

- `./app` (`src/entry/app.ts`) is the Kody web app. `handleDashboard(request, deps, base)` serves it. The routes are `/login`, `/logout` and `/`.
- Every page except the login needs a session. A request without a session, or with a user that is not on the allowlist, gets the login page and no data. An empty allowlist lets no one in.
- The allowlist is in the deployment config, not in the code. `./configure` takes the optional `allowlist`: a list of `{ user, tokenDigest }`. `tokenDigest` is the SHA-256 of the login token in hex. The owner makes the token and the digest. The app never shows the token.
- Views: unpaid Payments, next due Payments (date, amount), paid Payments, and the spend per Child per month and per school year. `schoolYearOf` maps September to December of year N and January to June of year N+1 to "N/N+1". July and August are in no school year. The spend counts `paid` Payments only.
- The texts come from the pl/en catalogs (`dashboard.*`) in the default language of the Family.
- Each `pending` Payment in the unpaid table has a `Paid` and a `Skip` button. A button posts to `/payments/<payment id>/paid` or `/payments/<payment id>/skip`. The handler calls `StorageAdapter.setPaymentStatus`, the same function as the Telegram callback, with the dashboard user as `decidedBy`. A request without a session changes nothing.
- The first press wins. A repeated press, or a press for an unknown Payment, changes nothing. Each press ends in a redirect to the overview. The session cookie is `SameSite=Lax`, so a form on another site cannot press a button.

## Telegram webhook

- The Kody webhook `telegram-update` (`./telegram-update`, `src/entry/telegram-update.ts`) receives the Telegram updates. It uses `responseMode` `ack` and `url-secret` verification.
- `routeTelegramUpdate` sends a `pay:` callback to `handlePaymentCallback`. The `callback_query` gives the id, the data, the chat ID, the message ID and the caption. A callback without a message changes nothing. Any other update is ignored and logged.
- The reply goes through `@tomiwu/telegram` with the secret `TELEGRAM_BOT_TOKEN`.
- The code does not register the webhook with Telegram. The owner calls `setWebhook` by hand with the webhook URL.
