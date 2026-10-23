# 0005 The bot shows a payment QR code and never pays

## Status

Accepted.

## Context

`packages/payments-watch` helps the owner to pay the Fees of the Organizers. The bank has no API for private persons. Each transfer needs a confirmation in the bank app. The bank sends no mail for outgoing transfers.

## Decision

- The bot NEVER pays. It never logs in to a bank. It never starts a transfer.
- For each due Payment, the bot sends one Notification with a ZBP QR code. The owner scans the code in the bank app and confirms the transfer there.
- The `Paid` and `Skip` buttons are the only source of the paid status. The bot does not detect a paid transfer.
- The code holds no bank credentials. The Fee rows hold the account of the Organizer only.

## Consequences

- The owner must check the transfer in the bank app before the confirmation. The caption shows the recipient name for this check.
- The paid status can be wrong if the owner pays and does not press the button. The reminder and the Dashboard reduce this risk.
- A bank change cannot break the bot, because the bot does not use the bank.
- If a bank API for private persons becomes available, a new ADR must replace this one before the bot can start a transfer.
