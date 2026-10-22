# Agent notes: @tomiwu/librus-watch

Watches Librus Synergia for one Family and sends new Items (grades, messages, announcements, trips, homework, absences, substitutions, lessons) to the Recipients on Telegram. The config lives in Supabase.

## Imports

```ts
import children from "kody:@tomiwu/librus-watch/children";
import lessons from "kody:@tomiwu/librus-watch/lessons";
import upcoming from "kody:@tomiwu/librus-watch/upcoming";
```

| Export | Input | Output | Side effects |
| --- | --- | --- | --- |
| `./children` | none | `{ children: { id, name, calendar_id }[] }` | none (read-only) |
| `./lessons` | `{ childId? }` | Lessons of the next 14 days | logs in to Librus, read-only |
| `./upcoming` | `{ childId?, days? }` | homework and tests with their Lesson | logs in to Librus, read-only |
| `./scheduled` | none | `{ ok: true }` | runs the Watchers, writes Items and the Outbox, sends Telegram messages |
| `./purge` | none | `{ ok: true, removed }` | deletes delivered Outbox rows older than 30 days |

`./scheduled` and `./purge` are the jobs in `package.json` (`kody.jobs`). Do not call them as a test: `./scheduled` can send real messages.

## Config

`./configure` with `{ supabaseUrl, familyId }` saves the plain deployment config in the package storage. Without it every export rejects with a message that names `./configure`.

## Secrets

Secrets are `{{secret:NAME}}` placeholders that Kody fills in at fetch time; code never sees a value. `SUPABASE_KEY`, `TELEGRAM_BOT_TOKEN`, and the account secrets named in the `accounts` table (`login_secret`, `password_secret`). Never read, print or change their values.

## Smoke tests

1. `children` with `{}`: returns at least one Child. This proves the config and `SUPABASE_KEY`.
2. `lessons` with `{ childId }` from step 1: returns Lessons. This proves the Librus login. Do not pass `days`; `lessons` rejects it.
3. `upcoming` with `{ childId, days: 7 }`.

## Edge cases

- Without `childId`, `lessons` and `upcoming` need a Family with exactly one Child with Librus; otherwise they reject.
- The first run of each scope (`<watcher>:<child id>`) is a silent Baseline: nothing is sent.
- A failing Account or Watcher does not stop the others. `./scheduled` rejects at the end with all failures joined by `; `.
- Librus maintenance windows make the login fail; retry later instead of changing config.
- Exports that take no input reject any non-empty object.
- Delivery uses the external package `@tomiwu/telegram` (`send-message`). It must be installed in the same account.
