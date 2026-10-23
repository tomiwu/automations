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

## Payment engine

- `runPayments` reads the Family config, the Fees and a `FeeSource`. It uses the day and month in the Family time zone.
- On `notifyDay` or later, an enabled Fee with an amount above 0 gets one `pending` Payment for the month. An existing Payment is not made again.
- Each Recipient of the Child gets one Outbox entry with the key `payment:<payment id>:<chat id>`.
- On `reminderDay` or later, a `pending` Payment gets one reminder with the key `payment:<payment id>:<chat id>:reminder`.
- A `paid` or `skipped` Payment gets no Notification. A repeated run queues nothing twice.
