# @tomiwu/librus-watch

The Librus Watcher, the `lessons` and `upcoming` exports, and the Morning report.

## How it works

- `runLibrusWatch` loads the config with `loadConfig`. It validates it with `validateConfig`.
- It runs each enabled `librus` Account of each Child with `has_librus`. A bad Account gives one error. The other Accounts still run.
- Secret values come from `Runtime.secret(account.login_secret)` and `Runtime.secret(account.password_secret)`.
- The Watchers are: grades, messages, announcements, trips, homework, absences, substitutions, lessons, meetings, schoolFreeDays, classFreeDays. The last three (parent meetings, school days off, class days off) read one API 2.0 endpoint each, store their content in `item_details` (kinds `meeting`, `dayOff`) and send no Notification: the Morning report shows them. The grades Watcher reads date, category and teacher from the `title` of the grade link on the same page (no extra fetch) and stores each new grade in `item_details` (kind `grade`).
- The Items of one Child at one Watcher have the scope `<watcher>:<child id>`. The first run of a scope is a silent Baseline. The record `__baseline__` marks a scope as baselined, also when Librus gave no Item.
- A new or updated Item queues one Notification for each Recipient that has the Child in `child_ids`. The text is rendered from the pl/en catalogs in the language of the Recipient. The Outbox key is `<watcher>:<child id>:<item>:<chat id>`.
- A failed Watcher queues one failure Notification a day for each Recipient of the Child. The other Watchers still run.
- On weekdays the 04:30 UTC run also queues the Morning report (`report:<child id>:<day>:<chat id>`). The optional port `afterSchool` adds the after-school section.
- At the end, `deliverPending` sends the Outbox through the `Messenger` port. A failed chat does not block the other chats.
- Each run reads the config, so each run is also the keepalive read of Supabase (`loadConfig` reads the `families` table). The runs are at least twice a day.

## Entry files

Only `src/entry/*` imports the Kody runtime and the Kody `telegram` package.

| Export | Result |
| --- | --- |
| `./scheduled` | One scheduled pass. It takes no input. It rejects when something failed. |
| `./upcoming` | `{ childId?, days? }`. Homework and tests with the Lesson they fall on. |
| `./lessons` | `{ childId? }`. The Lessons of the next 14 days. |
| `./purge` | The daily job. It calls `purgeDelivered(30)` and returns `{ ok, removed }`. It takes no input. |
| `./calendar` | `{ childId? }`. The Lessons of the next 14 days and the homework and tests of the same days, in one read with one Librus login. Use it instead of `lessons` plus `upcoming`. |
| `./children` | No input. `{ children }`: `id`, `name` and `calendar_id` of every Child. |
| `./events` | `{ childId?, from?, to?, since? }`. The stored content of the Items (meetings, days off, trips, Terminarz entries, announcements, messages, grades) as `events`. `from` and `to` are `YYYY-MM-DD`; `since` is an ISO time for `firstSeen` (default 7 days ago). It reads Supabase only: no Librus login. |

Both exports include `childId` and the name of the Child. Without `childId` the Family must have one Child with Librus.
The Supabase URL and the Family ID are plain config set with `./configure` (`{ supabaseUrl, familyId }`). The secret `SUPABASE_KEY` gives access to the storage.

## Stored content (`item_details`)

- The Watchers for messages, announcements, trips, Terminarz entries, meetings, days off and grades store the full content of each new Item in the table `item_details` (migration `0006_item_details.sql`). A row has `kind`, `source_id`, `date`, `start_time`, `end_time`, `title`, `text`, `sender`, `subject`, `category`, `source_updated_at` and `first_seen`.
- An Item with changed content adds a new row (another `content_hash`). The old row stays.
- The role `automations_watcher` can only read and insert `item_details`. It cannot update or delete.
- **Data is kept forever.** `daily-purge` removes only delivered Outbox rows older than 30 days. It never touches `item_details` or `items`.

## The `./events` export

- **Input:** `{ childId?, from?, to?, since? }`. `from` and `to` are `YYYY-MM-DD` and filter on the event date. `since` is an ISO time and filters on `firstSeen` (default: 7 days ago). Other keys are rejected.
- **Output:** `{ childId, child, from, to, since, events, fetches? }`. Each event has `id`, `kind`, `date`, `endDate`, `start`, `end`, `title`, `text`, `sender`, `subject`, `category`, `sourceUpdatedAt` and `firstSeen`.
- `id` is `<kind>:<source id>@<content hash>`. It changes when the content changes.
- `endDate` is set for trips and days off that cover a range of days. `date` of an announcement or a message without a date is the local day of `firstSeen`.
- Events are sorted by `firstSeen`, then by `date`.
- The export reads Supabase only (config and `item_details`). It makes no Librus login.

## Fetch budget

The Kody free plan allows 2500 outbound fetches in a UTC week. This package keeps its use low:

- **Count.** `entryDeps` wraps the fetch of the runtime in `countFetches`. Each scheduled run, purge run and export logs `fetches total=N <host>=n ...` and returns `fetches: { total, hosts }`. The Telegram sends go through the `telegram` package and are not in the count.
- **Name cache.** The names behind Librus IDs (`Users`, `Subjects`, `HomeWorks/Categories`) are kept in the package storage, one entry for each Account (`librus-names:<account id>`), for 7 days. A second run with the same IDs makes no name fetch.
- **One config read.** `loadConfig` reads the Family and its Children, Accounts, Activities and Recipients in one request. The credentials of the Family load in one request on the first `runtime.secret` call. A run needs 2 Supabase requests for config and credentials.
- **Per run.** A scheduled run needs about 2 Supabase requests for config and credentials, plus the Librus pages of each enabled Watcher, plus batched Supabase writes. `./events` needs only Supabase requests. The counter in the log shows the real numbers.
- **Batched writes.** `enqueueNotifications` and `markDeliveredMany` write many Outbox entries in one request. Delivery marks the sent entries once at the end of the run.

## Not in this package

The Telegram bot commands (`/librus_*`), the pause state and the `grades` and `messages` exports are not ported.
The schedule is in `package.json` (`kody.jobs`). Cron is in UTC: `scheduled-check` runs at 04:30 and 12:30 UTC, `daily-purge` at 03:30 UTC.

## Telegram update router

`routeTelegramUpdate(update, handlers)` sends a callback with data that starts with `pay:` to `handlers.payment` (the handler `handlePaymentCallback` of `payments-watch`). It sends all other updates to `handlers.other`, as before.
