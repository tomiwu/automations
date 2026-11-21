# @tomiwu/payments-watch

Builds ZBP payment QR codes for the Fees of the Organizers. The bot never pays (see ADR 0005).

## How it works

- `buildZbpText` makes the content `NIP|PL|NRB|AMOUNT|RECIPIENT|TITLE|||`.
- The NIP is 10 digits or empty. The NRB has 26 digits. Both need a correct checksum.
- The amount is in grosze, with at least 6 digits and leading zeros. An amount of 0 is rejected.
- The recipient is cut to 20 characters. The title is cut to 32 characters. A character that is not allowed becomes a space.
- The full text has 160 characters or less.
- `buildZbpQr` gives `{ text, png }`. The PNG uses UTF-8, error correction L and a border of 4 modules.
- The package must not use a CommonJS `require` of a Node built-in (the Kody ESM bundle fails at load time). The PNG is encoded in `src/png.ts` and the QR matrix comes from the `qrcode` core. `src/kody-bundle.test.ts` checks every Kody entry.

## Fee sources

- A `FeeSource` has `amountFor(fee, month)`. It gives `{ feeId, month, amount, source }` or `undefined`.
- `createConfigFeeSource` gives the `amounts` value of the Fee for the month, with `source: "config"`. It gives `undefined` when the month has no amount. The engine ignores an amount of 0.

- `parseOrganizerAmount(html, month)` reads the amount in grosze from the fee table of an Organizer page (`table.fees`, one `tr[data-month="YYYY-MM"]` with a `.amount` cell). It gives `undefined` for a month with no amount. It throws when the page has no fee table.
- `createWebFeeSource` is the page source. A Fee with a `sourceUrl` gets one GET of that page with `Runtime.fetch`. The page amount wins (`source: "page"`). When the config has a different amount, it stays in `configAmount`.
- `parseFeePage(type, html, month)` has one parser for each Organizer type: `edusky` (`table.edusky-charges`), `mondo` (`.mondo-fees`) and `plain` (`table.fees`, the same as `parseOrganizerAmount`). Each gives grosze, or `undefined` for a month with no amount. Each throws when its fee list is not in the page.
- `organizerTypeOf(url)` picks the type from the host name of the `sourceUrl` (`edusky` or `mondo` in the name). Other hosts are `plain`. An Organizer with no fees on its page has no `sourceUrl` and uses the config only.
- ActiveNow Fees use `accountId` (an Account with `service = activenow`), not the old `.an-fees` page parser. `./scheduled` uses `createPaymentFeeSource`, which logs in through `@tomiwu/activities-watch`, reads the Rozliczenia settlements table, and marks covered months `paid` with `decidedBy: organizer:activenow` without a Telegram Payment message.
- A Fee without a `sourceUrl`, a page without the month, or a failed page gives the config amount. A failed page also queues one failure Notification a day for each Recipient of the Child (`failure:<fee id>:<day>:<chat id>`).
- `./scheduled` uses the page source.

## Payment engine

- `runPayments` reads the Family config, the Fees and a `FeeSource`. It uses the day and month in the Family time zone.
- On `notifyDay` or later, an enabled Fee with an amount above 0 gets one `pending` Payment for the month. An existing Payment is not made again.
- Each Recipient of the Child gets one Outbox entry with the key `payment:<payment id>:<chat id>`.
- On `reminderDay` or later, a `pending` Payment gets one reminder with the key `payment:<payment id>:<chat id>:reminder`.
- A `paid`, `skipped` or `cancelled` Payment gets no Notification. A repeated run queues nothing twice.
- A Fee that is disabled (`enabled = false`) while the Payment of the current month is `pending` gets one `PaymentCancelled` (`cancelReason: "fee_disabled"`, `cancelledAt`) and the status `cancelled` (payments contract v0.2 section 3b). One pass is enough. A `paid` or `skipped` Payment stays. Paid/Skip on a cancelled Payment changes nothing and answers "This Payment is cancelled". Its Outbox entries are dropped. The Dashboard shows it under "Cancelled" only (not in next due, not in spend).
- Organizer cancel (payments contract v0.2 section 3b): `readFeePage(type, html, month)` gives `listed`, `cancelled` (the charge row is marked cancelled), `absent` (other charges are in the page, this one is not), `withdrawn` (the page shows the Child as not enrolled) or `empty` (no charge found). The web source keeps this as the `observationFor(fee, month)` of the one GET it already makes (no new fetch). A failed, capped or skipped GET, a page without the fee list, and an `empty` page give no observation: they never count and never cancel.
- A pending Payment that exists at the start of the pass counts one step for each successful pass with the same candidate (`organizer_void` for `cancelled` or `absent`, `organizer_withdrawn` for `withdrawn`). After `CANCEL_AFTER` = 2 steps the pass appends one `PaymentCancelled` with `cancelReason` and `cancelEvidence` (`<host type>:<code>`, for example `plain:charge_absent`), and sets the status to `cancelled`. A pass that lists the charge resets the count. The counters are in the package storage (key `organizerCancelCounters`, passed as `counters`), not in the Journal. They are saved after the append; without `counters`, an Organizer page cancels nothing. A `paid` or `skipped` Payment is not changed.
- When the charge is listed again after an `organizer_void` or `organizer_withdrawn` cancel, the pass appends a new `PaymentDue` on the same stream (next `seq`, without the cancel fields) and the status is `pending` again (`reopenCancelledPayment`). A `fee_disabled` cancel stays.

## Journal dual write

- `runPayments` reads the heads of the `payment:` streams once. For each due Fee with an amount above 0 it plans `PaymentDue` or `PaymentChanged` (`planPaymentDue`). It appends all events of the pass, with one `CheckCompleted` for each Child that has an enabled Fee, in ONE `appendEvents` call. A failed pass appends the Payment events and no `CheckCompleted`.
- A pending Payment with a changed amount gets `updatePendingAmount` (`amount`, `amount_source`). A `paid` or `skipped` Payment gets no event and no change. `fees` is never changed.
- `runPaymentsWatch` records which Payment keys the delivery sent. `recordSent` then appends `PaymentChanged` with `notifiedAt` (first Notification) or `remindedAt` (reminder), the same amount and amount source, and sets `notified_at` or `reminded_at` (`markPaymentSent`). A failed append (for example a `seq` conflict) changes nothing.
- The journal payload has no QR text, account, NIP, title, recipient name or source URL.
- The Outbox keys do not change. There is no new site fetch.

## Decision steps

- `decidePayment` (`src/decision.ts`) is used by the Telegram callback and the Dashboard, after their Recipient or allowlist check.
- It reads the head of the stream `payment:<childId>:<feeId>:<month>` and plans the decision with `planPaymentDecision`. It appends `PaymentPaid` or `PaymentSkipped`, then calls `setPaymentStatus` (dual write, projection).
- When the head is missing (a Payment made before the Journal), it first plans `PaymentDue` from the projection row. Both events go in ONE `appendEvents` call.
- A Payment that is not `pending`, a decided head, or a failed append (for example a `seq` conflict) changes nothing. It gives `false`.

## Notifier

- The port `Notifier.sendPayment(recipient, notice, qr)` takes the Recipient, a `PaymentNotice` (`child`, `fee`, `payment`) and the QR code.
- `createTelegramNotifier` is the v1 adapter. It calls `sendPhoto` with the QR PNG, a caption and two inline buttons.
- QR photo delivery (`payment-delivery.ts`): when the deployment config has `paymentPhotos: true`, the scheduled pass sends each Payment entry of the Outbox (`payment:<id>:<chat>` and `payment:<id>:<chat>:reminder`) with the Notifier, not as text. The reminder is the same `sendPhoto` as the first Notification: the QR code is built again at send time from the Fee and the Payment amount (page over config), the caption starts with "Reminder: not paid yet." ("Przypomnienie: brak wpłaty."), and it has the Paid and Skip buttons. An entry is not sent (it is marked delivered) when the Payment is not `pending` any more, when `remindedAt` (or `notifiedAt` for the first Notification) is set already, or when the Fee or Payment is missing. A failed `sendPhoto` keeps the entries of that chat for the next pass and is returned as a failure.
- `paymentPhotos` is off by default. Then all Payment entries go as text, as before. Before the owner turns it on, test one `sendPhoto` through the Kody `telegram` capability: it is not verified yet that the capability uploads a binary photo (multipart form).
- The callback data is `pay:<payment id>:paid` and `pay:<payment id>:skip`.
- The caption and the button names come from the pl/en catalogs in the language of the Recipient. The caption shows the Child, the Organizer, the month, the amount, the due date and the amount source.
- When the Payment amount comes from the page and the config has a different amount for the month, the caption shows both amounts.
- `createTelegramHttpClient(fetch, token)` is a `TelegramClient` that posts to the bot API. The token is the existing `TELEGRAM_BOT_TOKEN`. No new secret is needed.

## Cancel edit

- A `paid` Payment that the Organizer no longer lists (same N=2 pass rule and reset rules as the Organizer cancel) gets the refund-check flag `payments.refund_check_at` (migration 0014, `flagRefundCheck`). No Journal event is made and the status stays `paid`. Each Recipient of the Child gets one notice (Outbox key `refund-check:<payment id>:<chat id>`). The Dashboard shows the flag on the paid row. A `skipped` or `cancelled` Payment gets nothing.
- When a QR photo is sent (first Notification or reminder), the Telegram message ID is stored in the Outbox row (`outbox.message_id`, migration 0013, `recordMessageId`). It is a delivery field like `delivered_at`. It is not in the Journal.
- `editCancelledMessages` runs in each pass (`RunDeps.client`, set by `./scheduled` when `paymentPhotos` is on). For each `cancelled` Payment whose head is `PaymentCancelled`, it edits each stored message of each Recipient: the caption becomes "CANCELLED, do not pay." plus the reason, and the Paid and Skip buttons are removed (`editMessageCaption` with an empty keyboard).
- `fee_disabled`: edit only. `organizer_void` and `organizer_withdrawn`: edit, and one short new text message to the Recipient (Outbox key `cancel-notice:<payment id>:<seq>:<chat id>`, sent by the text delivery of the same pass).
- The edit is done once for each cancel and Recipient (Outbox key `cancel-edit:<payment id>:<seq>:<chat id>`, `seq` of the `PaymentCancelled` event). A repeated run does nothing.
- A Payment with no stored message ID (sent before this change) gets no edit and no error. A failed edit (for example a Telegram 400 for an old or deleted message) is logged. The run continues and the cancel stays. The edit is not tried again.
- The texts are in the pl/en catalogs (`payment.cancelled.*`).

## Callback

- `handlePaymentCallback(deps, query)` handles a button press with the data `pay:<payment id>:paid` or `pay:<payment id>:skip`. It gives `false` for other data.
- Only a Recipient of the Child of the Fee can change the Payment. Another chat gets an error answer and the Payment stays as it is.
- The first press appends the decision event and then sets the status and `decidedBy` (the chat ID) in the projection (see Decision steps), answers the press, edits the caption with the new status and removes the buttons.
- A second press changes nothing and appends nothing. The chat gets the answer "already". A `seq` conflict gives the same answer.
- The paid table is ordered by the time of the decision, newest first (no date last). It has three more columns: "Paid at" (`payments.decided_at`, local `YYYY-MM-DD HH:MM` in the Family time zone), "Marked by" and "Amount source" (`page` or `config`). `markedByOf` (`src/dashboard-data.ts`) maps `decided_by`: digits with an optional `-` is "Telegram" (the chat ID is never shown), `organizer:<service>` is "Auto (<service>)", any other text is "Dashboard (<user>)", null is "—".
- The texts come from the pl/en catalogs. A chat that is not a Recipient gets the default language of the Family.

## Entry files and Kody job

- `runPaymentsWatch` runs the Payment engine with a `FeeSource`, then delivers the Outbox to the Recipients. It gives the failure texts.
- `./scheduled` (`src/entry/scheduled.ts`) is the job `scheduled-check`. It runs once a day at 08:00 UTC (cron is in UTC). It takes no input and rejects when a step failed.
- `./configure` (`src/entry/configure.ts`) takes `{ supabaseUrl, familyId, credentialKey }`. Only the owner calls it.
- Only the entry files import the Kody runtime. The only Kody secret is `SUPABASE_KEY`. The delivery uses `TELEGRAM_BOT_TOKEN` through `@tomiwu/telegram`.

## Dashboard

- `./app` (`src/entry/app.ts`) is the Kody web app. `handleDashboard(request, deps, base)` serves it. The routes are `/login`, `/logout` and `/`.
- Every page except the login needs a session. A request without a session, or with a user that is not on the allowlist, gets the login page and no data. An empty allowlist lets no one in.
- The allowlist is in the deployment config, not in the code. `./configure` takes the optional `allowlist`: a list of `{ user, tokenDigest }`. `tokenDigest` is the SHA-256 of the login token in hex. The owner makes the token and the digest. The app never shows the token.
- Views: unpaid Payments, next due Payments (date, amount), paid Payments, and the spend per Child per month and per school year. `schoolYearOf` maps September to December of year N and January to June of year N+1 to "N/N+1". July and August are in no school year. The spend counts `paid` Payments only.
- The texts come from the pl/en catalogs (`dashboard.*`) in the default language of the Family.
- Each `pending` Payment in the unpaid table has a `Paid` and a `Skip` button. A button posts to `/payments/<payment id>/paid` or `/payments/<payment id>/skip`. The handler calls `decidePayment`, the same function as the Telegram callback, with the dashboard user as `decidedBy`. A request without a session changes nothing.
- The first press wins. A repeated press, or a press for an unknown Payment, changes nothing. Each press ends in a redirect to the overview. The session cookie is `SameSite=Lax`, so a form on another site cannot press a button.

## Telegram webhook

- The Kody webhook `telegram-update` (`./telegram-update`, `src/entry/telegram-update.ts`) receives the Telegram updates. It uses `responseMode` `ack` and `url-secret` verification.
- `routeTelegramUpdate` sends a `pay:` callback to `handlePaymentCallback`. The `callback_query` gives the id, the data, the chat ID, the message ID and the caption. A callback without a message changes nothing. Any other update is ignored and logged.
- The reply goes through `@tomiwu/telegram` with the secret `TELEGRAM_BOT_TOKEN`.
- The code does not register the webhook with Telegram. The owner calls `setWebhook` by hand with the webhook URL.

## The `./activenow-ledger` export

- **Input:** `{ monthsBack? }`. `monthsBack` is an integer 1..6. The default is 3. Other keys are rejected.
- **Output:** `{ today, from, accounts, fees, fetches? }`. `today` and `from` are UTC `YYYY-MM-DD` dates. `from` is the first day of the month `monthsBack - 1` months before `today`. Each Account is an enabled config row with `service = activenow`, in config order: `accountId`, `childId`, `child`, `group`, `origin`, `banner`, `rows` (with `date`, `title`, `amount` in grosze, `kind`, `upcoming`), `olderRows`, `matched` (`checked`, `openThroughToday`) or `null` on error, and `error`. `fees` lists every Fee with `activenowWithoutAccount` when the `sourceUrl` host contains `activenow` and `accountId` is null.
- **Reads:** Supabase config and Fees, then for each enabled ActiveNow Account one login and the settlements index and upcoming table (at most 6 ActiveNow requests per Account). A block page stops further ActiveNow reads. Other Account errors are recorded and the export continues.
- **Writes:** none. No cache, Payment, event or notification.

## The `./stored-payments` export

- **Input:** `{ childId?, month? }`. `month` is `YYYY-MM`. It is the current month in the Family time zone by default, and at most 12 months back. Other keys are rejected.
- **Output:** `{ timezone, month, lastSavedAt, payments, fetches? }`. `payments` are the head states of the `payment:` streams of the month, ordered by `dueDay`. Each has `stream`, `seq`, `eventType`, `lastChanged`, `childId` (the Journal `child_id`), `feeId`, `organizer`, `month`, `dueDay` (1 to 28), `status` (`pending`, `paid`, `skipped` or `cancelled`; a cancelled head also has `cancelReason` and `cancelledAt`), `amount` (grosze), `amountSource`, `notifiedAt`, `remindedAt`, `decidedAt` and `decidedBy`. A reader derives `overdue` from `status`, `month` and `dueDay`, and only for `pending`.
- `lastSavedAt` maps each Child ID to the time of the last `CheckCompleted` in `check:payments-watch:<childId>`, or `null` before the first check.
- It never returns a bank account, NIP, title, recipient or source URL.
- **Fetches:** the config, the payment heads and the check heads. This is 3 Supabase fetches. There is no organizer or Librus fetch.
- The Dashboard keeps reading the `payments` table until the dual write ends. Other readers can use this export now.
