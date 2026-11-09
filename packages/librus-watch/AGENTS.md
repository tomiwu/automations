# Agent notes: @tomiwu/librus-watch

Watches Librus Synergia for one Family and sends new Items (grades, messages, announcements, trips, homework, absences, substitutions, lessons, parent meetings, school days off, class days off) to the Recipients on Telegram. The config lives in Supabase.

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
| `./calendar` | `{ childId? }` | Lessons and upcoming homework and tests of the next 14 days, one login | logs in to Librus, read-only |
| `./upcoming` | `{ childId?, days? }` | homework and tests with their Lesson | logs in to Librus, read-only |
| `./stored-lessons` | `{ childId?, from?, to? }` | `{ childId, child, timezone, from, to, lastSavedAt, lastCheck, lessons, homework }`. A Lesson on a Librus day off has `status: "cancelled"`, `cancelled: true` and `cancelReason: { reason: "day_off", sourceStream, sourceId }`. Entries have `vanished`, `seq`, `lastChanged` | none (reads Supabase only, 4 fetches at most) |
| `./stream-history` | `{ stream }` | `{ stream, events, state }`. `state` is `null` for an unknown stream | none (reads Supabase only, 1 fetch) |
| `./events` | `{ childId?, from?, to?, since? }` | `{ childId, child, from, to, since, events }`. Each event: `id`, `kind`, `date`, `endDate`, `start`, `end`, `title`, `text`, `sender`, `subject`, `category`, `sourceUpdatedAt`, `firstSeen` | none (reads Supabase only, no Librus login) |
| `./scheduled` | none | `{ ok: true }` | runs the Watchers, writes Items and the Outbox, sends Telegram messages |

`./scheduled` is the only job in `package.json` (`kody.jobs`). Do not call it as a test: `./scheduled` can send real messages.

## Stored content

The Watchers store the full content of each new Item in the Supabase table `item_details`. The meetings and days-off Watchers send no Notification; the Morning report lists them. `./events` reads this table. `from` and `to` are `YYYY-MM-DD`; `since` is an ISO time for `firstSeen` (default 7 days ago). Data is kept forever: no job deletes `item_details`, `journal_events` or Outbox rows. Changed content adds a new row with a new event `id`.

## Journal

`./scheduled` appends Lesson and homework events to the append-only table `journal_events` (ADR 0006). It uses only data that the run read already. The calendar sync must use `./stored-lessons` (and `./stream-history` for one stream). It must not use `./lessons`, `./calendar` and `./upcoming`: those log in to Librus and stay for manual use. `from` defaults to today, `to` to `from` + 13 (at most 60 days). Check `lastSavedAt` and `lastCheck` for stale data. Nothing changes or deletes a Journal event.

## Config

`./configure` with `{ supabaseUrl, familyId, credentialKey }` (owner only) saves the deployment config in the package storage. Without it every export rejects with a message that names `./configure`.

## Secrets

`SUPABASE_KEY` is the only Kody secret (a literal `{{secret:SUPABASE_KEY}}` placeholder). `TELEGRAM_BOT_TOKEN` is used by `@tomiwu/telegram`. The service logins (the names in `accounts.login_secret` / `password_secret`, and so on) are AES-256-GCM rows in the Supabase table `credentials`, decrypted in the run with the key from `./configure`. Never read, print or return their values.

## Smoke tests

1. `children` with `{}`: returns at least one Child. This proves the config and `SUPABASE_KEY`.
2. `lessons` with `{ childId }` from step 1: returns Lessons. This proves the Librus login. Do not pass `days`; `lessons` rejects it.
3. `upcoming` with `{ childId, days: 7 }`.
4. `events` with `{ childId }`: returns `events` (can be empty). It needs no Librus login.
5. `stored-lessons` with `{ childId }`: returns `lessons` and `homework` (can be empty before the first journal pass). It needs no Librus login.
6. `stream-history` with a `stream` from step 5: returns the `events` of that stream.

## Edge cases

- Without `childId`, `lessons` and `upcoming` need a Family with exactly one Child with Librus; otherwise they reject.
- The first run of each scope (`<watcher>:<child id>`) is a silent Baseline: nothing is sent.
- A failing Account or Watcher does not stop the others. `./scheduled` rejects at the end with all failures joined by `; `.
- Librus maintenance windows make the login fail; retry later instead of changing config.
- Exports that take no input reject any non-empty object.
- Delivery uses the external package `@tomiwu/telegram` (`send-message`). It must be installed in the same account.
