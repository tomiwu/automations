# 0006 Event journal: append-only history of what the jobs saw

## Status

Accepted (9.11.2026). The owner can veto.

## Context

The calendar sync must read only Supabase. It must never read Librus or the activity apps.
Before this change, Supabase did not keep the Lessons, the homework and tests, and the Sessions.
The calendar sync read them live through `./lessons`, `./calendar`, `./upcoming` and `./sessions`.
This used most of the Kody fetch limit (2500 outbound fetches each UTC week).

The owner wants event sourcing, as in the Akka Persistence journal:

- Each change goes to the database as an event. The history is complete.
- The jobs never delete or change a stored event. There is no purge of these rows. Outbox rows are kept forever too: the `daily-purge` job and `purgeDelivered` were removed (#154), and migration 0010 takes the `delete` right on `outbox` from the watcher role.
- The current state is a projection: a pure fold of the events of one stream.

## Decision

1. New table `journal_events`. One row is one Journal event.
   Columns: `family_id`, `child_id`, `stream`, `seq`, `kind`, `day`, `event_type`, `payload` (jsonb), `content_hash`, `recorded_at`, `source`.
   Primary key `(family_id, stream, seq)`. `seq` starts at 1 and grows by 1 in each stream.
2. The table is append-only:
   - The role `automations_watcher` gets only `select` and `insert`.
   - A trigger rejects each `update`, `delete` and `truncate`, for all roles.
   - `StorageAdapter` has no method that changes or removes a Journal event. A test checks that the Supabase adapter never sends `PATCH` or `DELETE` to `journal_events`.
   - The family foreign key uses `on delete restrict`.
3. Each event carries the full new state of its entity in `payload` (state-carrying events). So the fold is simple, and the last event of a stream gives the current state.
4. A view `journal_heads` (`security_invoker`) gives the last event of each stream. The jobs and the exports read it with one request. It is derived data, never a source of truth.
5. Streams:
   - `lesson:<childId>:<date>:<period>` (kind `lesson`).
   - `homework:<childId>:<librus id>` (kind `homework`; tests and quizzes too, with `isTest`).
   - `session:<childId>:<session id>` (kind `session`; the session ID is stable across moves).
   - `item:<scope>:<source id>` (kind = the Item kind: `meeting`, `dayOff`, `trip`, `terminarz`, `announcement`, `message`, `grade`).
   - `check:<source>:<childId or account id>` (kind `check`): one `CheckCompleted` event for each successful job pass. It gives "last saved at", so a reader can see stale data.
6. Event types:
   - Lesson: `LessonScheduled`, `LessonChanged`, `LessonCancelled`, `LessonSubstituted`, `LessonRestored`, `LessonVanished`.
   - Homework: `HomeworkAdded`, `HomeworkChanged`, `HomeworkVanished`.
   - Session: `SessionScheduled`, `SessionChanged`, `SessionCancelled`, `SessionMoved`, `SessionRestored`, `SessionVanished`.
   - Item: `ItemRecorded`, `ItemChanged`.
   - Check: `CheckCompleted`.
7. The jobs compare the downloaded data with the heads. They append only change events. No change gives no event (only the `CheckCompleted` event). They write in batches (at most 100 rows per request). They use only data that the job downloads already: no new Librus or app request.
8. An entity that was in the head state inside the read window, but is not in a successful download, gets a `...Vanished` event. A failed download gives no `...Vanished` event.
9. A conflict on `(family_id, stream, seq)` is an error of that pass (optimistic concurrency). The next pass reads the heads again.
10. The existing `item_details` rows move to the journal now (owner decision, 9.11.2026):
    - Migration `0008_journal_backfill.sql` copies each `item_details` row into `journal_events` as one event. The first row of an Item is `ItemRecorded`, a later row is `ItemChanged`. `recorded_at` = `first_seen`. The copy is idempotent: a row whose stream and `content_hash` are in the journal already is not copied again.
    - `item_details` stays. Nothing is deleted from it. The watcher writes both tables until the owner verifies the journal. Then `item_details` becomes read-only legacy (separate issue, label `needs-validation`).
    - `listDetails` (used by `./events` and the morning report) reads the journal. The output of `./events` does not change.
11. New read-only exports read Supabase only and report `fetches`:
    - `@tomiwu/librus-watch` `./stored-lessons`: Lessons, homework and tests of one Child for a day range, with `lastSavedAt`.
    - `@tomiwu/activities-watch` `./stored-sessions`: Sessions of all Children (or one Child) for a day range, with `lastSavedAt` for each Account.
    - `@tomiwu/librus-watch` `./stream-history`: all Journal events of one stream, oldest first.

## Options that we did not take

- Mutable state tables (upsert of the current row). Simple, but the history is lost. The owner rejected it.
- A projection table that a trigger keeps. It adds SQL logic that CI tests less well. The view `journal_heads` gives the same reads.
- Events with only the changed fields (deltas). Each reader must then read the whole stream. State-carrying events let a reader use the head only.
- Extend `./events` with Lessons and Sessions. The shapes are too different; one export per data type is clearer.

## Consequences

- The table grows forever. Estimate: about 200 Lessons and 50 Sessions each two weeks for two Children, and most passes change little. This is far below the free Supabase limit (500 MB).
- Each scheduled pass adds about 2 Supabase requests for each Child (read the heads, append one batch).
- The calendar sync needs about 2 to 3 Supabase fetches for each call and no Librus fetch.
- Old data is never lost. A bug in the fold can be fixed and the state computed again from the events.
