# Agent notes: @tomiwu/activities-watch

Watches the apps of the after-school Activities (ActiveNow, Edusky, Mondo) for one Family and sends cancelled and moved classes to the Recipients on Telegram. The config lives in Supabase.

## Imports

```ts
import sessions from "kody:@tomiwu/activities-watch/sessions";
import afterSchool from "kody:@tomiwu/activities-watch/after-school";
```

| Export | Input | Output | Side effects |
| --- | --- | --- | --- |
| `./sessions` | none | `{ sessions, errors }`, every Session of the next 14 days, ordered by start | logs in to the apps, read-only |
| `./stored-sessions` | `{ childId?, from?, to? }` | `{ timezone, from, to, accounts, sessions }`. Each Session has `vanished`, `seq`, `lastChanged`. Each Account has `lastSavedAt` | none (reads Supabase only, 3 fetches at most) |
| `./after-school` | `{ childId, day: "YYYY-MM-DD", language?: "pl" \| "en" }` | `{ text }` | read-only |
| `./scheduled` | none | `{ ok: true }` | runs the Watchers, writes Items and the Outbox, sends Telegram messages |

`./scheduled` is the job in `package.json` (`kody.jobs`). Do not call it as a test: it can send real messages.

## Journal

`./scheduled` appends Session events to the append-only table `journal_events` (ADR 0006), once at the end of the run, from the Sessions that it read already. The calendar sync must use `./stored-sessions`. It must not use `./sessions`: that export logs in to the apps and stays for manual use. `from` defaults to today, `to` to `from` + 13 (at most 60 days). Check `lastSavedAt` of each Account for stale data. Nothing changes or deletes a Journal event.

## Config

`./configure` with `{ supabaseUrl, familyId, credentialKey }` (owner only) saves the deployment config in the package storage. Without it every export rejects with a message that names `./configure`.

## Secrets

`SUPABASE_KEY` is the only Kody secret (a literal `{{secret:SUPABASE_KEY}}` placeholder). `TELEGRAM_BOT_TOKEN` is used by `@tomiwu/telegram`. The service logins (the names in `accounts.login_secret` / `password_secret`, `EDUSKY_CLIENT_SECRET` (Edusky only), and so on) are AES-256-GCM rows in the Supabase table `credentials`, decrypted in the run with the key from `./configure`. Never read, print or return their values.

## Smoke tests

1. `sessions` with `{}`: `errors` is empty and `sessions` is an array. Each Session has `childId` and `child`.
2. `stored-sessions` with `{}`: returns `accounts` and `sessions` (can be empty before the first journal pass). It needs no app login.
3. `after-school` with a `childId` from step 1 and today's `day`: returns `{ text }` (it can be empty on a day without classes).

## Edge cases

- One failing Account shows up in `errors` (for `./sessions`) or as a failure (for `./scheduled`); the other Accounts still run.
- An Account without an enabled Activity is an error.
- The first run of each scope (`<service>:<account id>`) is a silent Baseline: nothing is sent.
- Only updates that become `cancelled` or `moved` are sent. A change that starts within 24 hours is marked urgent.
- Mondo Sessions have no ID; a new time is a new Item.
- The status rules were not seen on a real cancellation or move yet (see README, "Not verified").
- Delivery uses the external package `@tomiwu/telegram` (`send-message`). It must be installed in the same account.
