# @tomiwu/librus-watch

The Librus Watcher, the `lessons` and `upcoming` exports, and the Morning report.

## How it works

- `runLibrusWatch` loads the config with `loadConfig`. It validates it with `validateConfig`.
- It runs each enabled `librus` Account of each Child with `has_librus`. A bad Account gives one error. The other Accounts still run.
- Secret values come from `Runtime.secret(account.login_secret)` and `Runtime.secret(account.password_secret)`.
- The Watchers are: grades, messages, announcements, trips, homework, absences, substitutions, lessons.
- The Items of one Child at one Watcher have the scope `<watcher>:<child id>`. The first run of a scope is a silent Baseline. The record `__baseline__` marks a scope as baselined, also when Librus gave no Item.
- A new or updated Item queues one Notification for each Recipient that has the Child in `child_ids`. The text is rendered from the pl/en catalogs in the language of the Recipient. The Outbox key is `<watcher>:<child id>:<item>:<chat id>`.
- A failed Watcher queues one failure Notification a day for each Recipient of the Child. The other Watchers still run.
- On weekdays at 07:00 local time the run also queues the Morning report (`report:<child id>:<day>:<chat id>`). The optional port `afterSchool` adds the after-school section.
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
| `./children` | No input. `{ children }`: `id`, `name` and `calendar_id` of every Child. |

Both exports include `childId` and the name of the Child. Without `childId` the Family must have one Child with Librus.
The Supabase URL and the Family ID are plain config set with `./configure` (`{ supabaseUrl, familyId }`). The secret `SUPABASE_KEY` gives access to the storage.

## Not in this package

The Telegram bot commands (`/librus_*`), the pause state and the `grades` and `messages` exports are not ported.
The schedule is in `package.json` (`kody.jobs`). Its time zone must be the time zone of the Family.
