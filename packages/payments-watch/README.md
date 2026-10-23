# @tomiwu/payments-watch

Builds ZBP payment QR codes for the Fees of the Organizers. The bot never pays (see ADR 0005).

## How it works

- `buildZbpText` makes the content `NIP|PL|NRB|AMOUNT|RECIPIENT|TITLE|||`.
- The NIP is 10 digits or empty. The NRB has 26 digits. Both need a correct checksum.
- The amount is in grosze, with at least 6 digits and leading zeros. An amount of 0 is rejected.
- The recipient is cut to 20 characters. The title is cut to 32 characters. A character that is not allowed becomes a space.
- The full text has 160 characters or less.
- `buildZbpQr` gives `{ text, png }`. The PNG uses UTF-8, error correction L and a border of 4 modules.
