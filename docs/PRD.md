# PRD: automations monorepo

## Problem

The school and activity watchers live in the private repo `kody`. The code contains family data: names, facilities, chat IDs, e-mails and paths. The config is in the code. To add a child, a person must change the code and deploy. The data store is Kody package storage. The owner wants an external database and a generic open-source codebase.

## Goals

1. One public-to-be monorepo `automations` with generic code and no personal data.
2. All family config is in Supabase. A person adds a child, an account or a recipient without a code change or a deploy.
3. Storage is behind the interface `StorageAdapter`. The implementation is `SupabaseStorage`.
4. Each recipient gets Telegram messages in the recipient's language (`pl` or `en`).
5. The code runs on Kody first. A runtime interface (fetch, secrets, scheduling) lets plain Node run it later.
6. The current data moves to Supabase once. No Item is reported twice after the switch.

## Non-goals

- No `KodyStorage` adapter for normal operation. The migration reads Kody storage one time only.
- No multi-family deployment. The schema has `family_id`, but one deployment serves one family.
- No admin commands in the Telegram bot (later work).
- The packages do not write to Google Calendar. An agent reads the exports and `children.calendar_id`.
- No change to the Telegram bot or to `TELEGRAM_BOT_TOKEN`.

## Words

- **Family**: One group of children and recipients. One deployment has one Family.
- **Child**: One pupil. A Child has a name, `has_librus` and a `calendar_id`.
- **Account**: The login of a Child at a Service. It holds the Service, the origin, the group and the NAMES of the secrets. It never holds a secret value.
- **Service**: An external app: `librus`, `activenow`, `edusky`, `mondo`.
- **Activity**: A recurring class after school, linked to a Child and an Account.
- **Recipient**: One Telegram chat with a language and a list of Children.
- **Item**: One fact that a Watcher saw (grade, message, lesson, session).
- **Outbox entry**: One queued Notification for one Recipient.
- **StorageAdapter**: The interface for Items, Outbox and config reads.
- **Runtime**: The interface for fetch, secrets, scheduling and logs.

## Repository layout

```
packages/shared            runtime interface, config types, i18n, HTTP session, time and schedule helpers
packages/librus-data       StorageAdapter, SupabaseStorage, in-memory fake, migration import
packages/librus-watch      Librus watcher, lessons and upcoming exports, morning report
packages/activities-watch  ActiveNow, Edusky and Mondo watchers, sessions export, mail compare
supabase/migrations        SQL: schema, RLS, restricted role
tools/admin                admin CLI (service_role, run on the owner's computer only)
docs/                      PRD, ADRs, setup, Kody deploy, Supabase setup, adding a child
examples/                  example rows and secret names (CHILD1_*, CHILD2_*)
.sandcastle/               code factory loop (implement, review, fix)
.github/workflows/ci.yml   install, typecheck, tests, gitleaks
```

Tooling: npm workspaces. No pnpm, no turbo. TypeScript, vitest. License: MIT.
`telegram` is an external dependency: an unchanged MIT copy of `@kody/telegram`. Do not copy it into `packages/`.

## Requirements

### Part A: repository and hygiene

1. Fresh git history. No commit from `kody` is copied.
2. No personal data in code, tests, fixtures, docs or examples. Fixtures use invented names (`Child One`, `Example School`) and fake chat IDs.
3. CI runs on each PR: `npm ci`, typecheck of each workspace, tests of each workspace, gitleaks on the full history.
4. A grep check in CI fails on a deny-list of personal strings. The deny-list is NOT in the repo. CI reads it from a GitHub secret. If the secret is empty, the step is skipped.
5. Code, README and docs are in English (ASD-STE100).
6. The repo is private until the owner approves the change to public.

### Part B: runtime interface

1. `shared` defines `Runtime`: `fetch`, `secret(name)`, `now()`, `log`, and a schedule description.
2. A Kody implementation maps `Runtime` to `kody:runtime`. A Node implementation reads `process.env` and uses global `fetch`.
3. Watcher code imports only `Runtime`, never `kody:runtime` directly. Only the entry files of each package import the Kody implementation.

### Part C: storage

1. `StorageAdapter` operations: `knownItemIds`, `listItems`, `recordItems`, `enqueueNotification`, `pendingNotifications`, `markDelivered`, `loadConfig(familyId)`.
2. The public functions of `librus-data` keep their current names and input shapes, so the watchers change little.
3. `SupabaseStorage` uses the PostgREST HTTP API with `SUPABASE_URL` and `SUPABASE_KEY` (restricted role). No Supabase SDK if plain fetch is enough.
4. An in-memory fake implements the same interface. One shared contract test suite runs against both.
5. `enqueueNotification` is idempotent on `key` (insert with conflict ignore).
6. Outbox entries are kept forever, also after delivery. There is no purge (removed in #154).
7. Keepalive: each scheduled run reads one row. The watchers run at least twice a day, so the free plan does not pause (7 days of no activity).

### Part D: schema (SQL migration)

Tables, all with `family_id` (except `families`):

- `families(id, name, timezone, default_language)`
- `children(id, family_id, name, has_librus, calendar_id)`
- `accounts(id, family_id, child_id, service, origin, "group", login_secret, password_secret, enabled)`
- `activities(id, family_id, child_id, account_id, name, weekday, start_time, end_time, place, enabled)`
- `recipients(id, family_id, telegram_chat_id, language check in ('pl','en'), child_ids uuid[])`
- `items(family_id, watcher, id, first_seen, primary key (family_id, watcher, id))`
- `outbox(key primary key, family_id, chat_id, text, queued_at, delivered_at)`

Access:

1. A role `automations_watcher` with RLS: SELECT on config tables; SELECT, INSERT on `items`; SELECT, INSERT, UPDATE (`delivered_at` only), DELETE (delivered rows older than 30 days) on `outbox`.
2. The admin CLI command `make-watcher-key` signs a JWT for `automations_watcher` with the project JWT secret. The owner runs it on the owner's computer and enters the result in Kody as `SUPABASE_KEY`. The key never goes to the agent. The `service_role` key is never in Kody. Only the admin CLI uses it.
3. The migration is idempotent and runs in the Supabase SQL editor.
4. CI starts a Postgres service container, applies the migration and tests RLS and the permissions of `automations_watcher`.

### Part E: config from the database

1. The watchers load the config with `loadConfig` at the start of each run. There is no family config in code.
2. Secret values come from Kody secrets through `Runtime.secret(account.login_secret)`. The owner enters each value in Kody and approves it for the host.
3. The deployment keeps its current Kody secret names, because the database holds only the names. Generic names such as `CHILD1_LIBRUS_LOGIN` and `CHILD2_MONDO_PASSWORD` appear only in `examples/` and `docs/`.
4. Validation: an unknown Service, a missing secret name or a bad language gives one clear error for that Account. Other Accounts still run.

### Part F: i18n

1. All user-facing messages, including the morning report and its after-school section, are in the catalogs. No user-facing text is in watcher code.
2. `shared` has message catalogs `pl` and `en` with the same keys. A test fails if a key is missing.
3. Each Outbox entry is rendered in the language of its Recipient. The Outbox key includes the chat ID.
4. A Recipient gets messages only for the Children in `child_ids`.

### Part G: admin CLI

1. `tools/admin` commands: `add-family`, `add-child`, `add-account`, `add-activity`, `add-recipient`, `list`, `disable-account`, `import-seed`, `make-watcher-key`.
2. It reads `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the environment of the owner's computer.
3. It does not accept secret values. `add-account` takes secret NAMES and prints the Kody secrets the owner must enter.

### Part H: migration and switch

1. A one-time Kody job reads the current `librus-data` storage and exports Items and Outbox entries.
2. An import script writes them to Supabase, then compares counts per Watcher and pending Outbox entries. It fails on a difference.
3. The real seed file is only on the owner's computer. It is never in the repo or on the box. The owner imports it one time with `admin import-seed`. After that, Supabase is the source of truth.
4. Switch: deploy the monorepo packages with the same names (`@tomiwu/librus-watch`, `@tomiwu/activities-watch`, private), then do a test read. Keep the previous version for a one-step rollback deploy. Only one version runs at a time.
5. The switch can happen at any time (not production-critical).
6. After one week of stable runs, archive `tomiwu/kody`.

### Part I: calendar consumers

1. The exports (`lessons`, `sessions`, `upcoming`) include `childId` and the Child name.
2. A new export `children` returns `id`, `name` and `calendar_id`, so the calendar agent finds calendars without a change.

## Part J: event journal (9.11.2026)

Goal: the scheduled Kody jobs save to Supabase all data that the calendar sync needs. The calendar sync reads only Supabase. It never reads Librus or the activity apps. See `docs/adr/0006-event-journal.md`.

1. Table `journal_events` is append-only. A trigger rejects `update`, `delete` and `truncate`. The watcher role gets `select` and `insert` only. The rows are kept forever. No purge job touches them.
2. Each change is one Journal event with the full new state in `payload`. The current state is a pure fold of the events of a stream. The view `journal_heads` gives the last event of each stream.
3. `librus-watch` `scheduled-check` appends Lesson events (14 days, with the substitute teacher and the cancelled status) and homework events (homework, tests and quizzes: content, teacher, Librus ID, date, lesson number). It uses the timetable and the homework that the Watchers download already. It makes no extra Librus request.
4. `activities-watch` `scheduled-check` appends Session events (14 days, all Children: Service, date, start, end, place, status, mail warning).
5. Each successful pass appends one `CheckCompleted` event for each Child or Account. The exports return it as `lastSavedAt`.
6. The existing `item_details` rows move to the journal with migration `0008_journal_backfill.sql`. `./events` and the morning report read the journal. `item_details` stays as legacy until the owner verifies the journal.
7. New exports, Supabase only, each returns `fetches`: `librus-watch` `./stored-lessons` and `./stream-history`, `activities-watch` `./stored-sessions`.

### Limits

- Kody free plan: 2500 outbound fetches each UTC week (reset Monday 00:00 UTC). Supabase requests count too.
- Kody cron is in UTC. `scheduled-check` runs at 04:30 and 12:30 UTC.
- Supabase free plan: 500 MB database, the project pauses after 7 days without requests.
- GitHub free plan, private repo: no branch protection. The loop merges only after CI is green.
- Migrations apply from CI (`.github/workflows/migrate.yml`) after CI is green on `main`. Deploys to Kody run from `.github/workflows/deploy-kody.yml`.

### Test decisions

- The pure parts (compare heads with downloaded data, choose the event type, fold) have unit tests with invented data.
- The storage methods `appendEvents`, `listHeads` and `listEvents` are in the shared contract suite. The suite runs against the memory adapter and the fake PostgREST.
- A test checks that the Supabase adapter never sends `PATCH` or `DELETE` to `journal_events`.
- `tools/sql-tests` test the migrations against Postgres: the trigger rejects `update`, `delete` and `truncate`; the watcher role can `select` and `insert` only; the backfill is idempotent. CI starts a Postgres service, so these tests run in CI.
- The fetch tests count Supabase requests with a fake fetch: each export makes at most 3 requests and no request to another host.
- No test uses real family data or a real service.

### Decisions (veto allowed)

| Question | Options | Default | Reason |
| --- | --- | --- | --- |
| Storage model | mutable tables; event journal | event journal | Owner requirement: full history, never delete. |
| Event payload | deltas; full state | full state | The head alone gives the state, so reads stay at 1 to 2 requests. |
| Projection | in code; trigger table; view | pure fold in code plus the view `journal_heads` | No SQL logic to keep in step; easy to test. |
| Existing `item_details` | migrate now; later | now, with dual write until verified | Owner decision 9.11.2026. |
| Exports | extend `./events`; new exports | new exports `./stored-lessons`, `./stored-sessions`, `./stream-history` | Different shapes; `./events` keeps its output. |
| Freshness | timestamp of last change; check event | `CheckCompleted` event each pass | Without a change there is no event, so "last change" cannot show staleness. |
| Homework window | 14 days ahead only; as the Watcher reads it | as the Watcher reads it (7 days back, all ahead) | No extra Librus request. |

## Code factory

The same approach as `kody`: this PRD, then issues with the label `Sandcastle` and a priority label, with `Blocked by`. The Sandcastle loop (Claude) takes the next unblocked issue, opens a PR, a review agent checks it, CI must pass, then a squash-merge. The `.sandcastle` setup is copied from `kody` with generic prompts (no names, no paths).

## Risks

- Personal data leaks into the public repo. Mitigation: fresh history, gitleaks, deny-list grep, review before the change to public.
- The Supabase free plan pauses. Mitigation: keepalive on each run.
- Duplicate messages after the switch. Mitigation: migration with count checks, one version at a time.
- PostgREST role and RLS errors. Mitigation: RLS and role tests against a Postgres service container in CI.
