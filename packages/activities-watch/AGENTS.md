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
| `./after-school` | `{ childId, day: "YYYY-MM-DD", language?: "pl" \| "en" }` | `{ text }` | read-only |
| `./scheduled` | none | `{ ok: true }` | runs the Watchers, writes Items and the Outbox, sends Telegram messages |

`./scheduled` is the job in `package.json` (`kody.jobs`). Do not call it as a test: it can send real messages.

## Config

`./configure` with `{ supabaseUrl, familyId }` saves the plain deployment config in the package storage. Without it every export rejects with a message that names `./configure`.

## Secrets

Secrets are `{{secret:NAME}}` placeholders that Kody fills in at fetch time; code never sees a value. `SUPABASE_KEY`, `TELEGRAM_BOT_TOKEN`, `EDUSKY_CLIENT_SECRET` (Edusky only), and the account secrets named in the `accounts` table. Never read, print or change their values.

## Smoke tests

1. `sessions` with `{}`: `errors` is empty and `sessions` is an array. Each Session has `childId` and `child`.
2. `after-school` with a `childId` from step 1 and today's `day`: returns `{ text }` (it can be empty on a day without classes).

## Edge cases

- One failing Account shows up in `errors` (for `./sessions`) or as a failure (for `./scheduled`); the other Accounts still run.
- An Account without an enabled Activity is an error.
- The first run of each scope (`<service>:<account id>`) is a silent Baseline: nothing is sent.
- Only updates that become `cancelled` or `moved` are sent. A change that starts within 24 hours is marked urgent.
- Mondo Sessions have no ID; a new time is a new Item.
- The status rules were not seen on a real cancellation or move yet (see README, "Not verified").
- Delivery uses the external package `@tomiwu/telegram` (`send-message`). It must be installed in the same account.
