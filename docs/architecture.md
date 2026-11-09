# Architecture

## Parts

| Part | Path | Job |
| --- | --- | --- |
| Shared | `packages/shared` | `Runtime` interface, config types and validation, i18n catalogs (`pl`, `en`), helpers |
| Storage | `packages/librus-data` | `StorageAdapter`, the Journal core (`journal.ts`), the Supabase adapter, the in-memory fake, the migration import |
| Librus | `packages/librus-watch` | Librus Watchers, Morning report, delivery of the Outbox, exports |
| Activities | `packages/activities-watch` | ActiveNow, Edusky and Mondo Watchers, `sessions` export, mail comparison |
| Kradziejka | `packages/kradziejka` | Telegram router to Grok bot routines. The registry is the table `kradziejka_bots`. |
| Payments | `packages/payments-watch` | Fee sources, Payment engine, ZBP QR code, Telegram Notifier and Dashboard. The bot never pays (ADR 0005). |
| Admin | `tools/admin` | CLI that edits the config in Supabase |
| SQL | `supabase/migrations` | Schema, RLS and the role `automations_watcher` |

## Data flow

1. A scheduled job starts. It reads the config with `loadConfig(familyId)`. This read is also the keepalive read.
2. For each enabled Account, the Watcher gets the secret values from `Runtime.secret(account.login_secret)` and `Runtime.secret(account.password_secret)`.
3. The Watcher reads the Service and compares the result with the known Item IDs.
4. The first run of a scope is a silent Baseline. After that, each new Item queues one Outbox entry for each Recipient that has the Child in `child_ids`.
5. The text of an entry comes from the catalog in the language of the Recipient.
6. `deliverPending` sends the Outbox entries to Telegram and sets `delivered_at`.
7. A daily job removes entries that were delivered more than 30 days ago.
8. After the Watchers, the same pass appends Journal events for the Lessons, the homework and the Sessions that it read. It reads the Heads, compares, and appends only the changes, plus one `CheckCompleted` event. It makes no new request to a Service.
9. The calendar sync reads the Journal through `./stored-lessons`, `./stored-sessions` and `./stream-history`. These read Supabase only. The exports `./lessons`, `./calendar`, `./upcoming` and `./sessions` log in to the Services and stay for manual use.

## Rules

- The database holds secret NAMES only. Secret values stay in the secret store of the platform.
- Watcher code imports the `Runtime` interface. Only `src/entry/*` files import the Kody runtime.
- Watcher code has no user-facing text. All text is in the i18n catalogs.
- The Outbox `key` includes the chat ID. `enqueueNotification` ignores a key that exists, so a repeated run does not send twice.
- The watcher key has the role `automations_watcher`. The role cannot change config rows. The `service_role` key stays on the computer of the owner.
- One deployment serves one Family. The secret `FAMILY_ID` holds its ID.

- The table `journal_events` is append-only. No job changes or deletes a Journal event (ADR 0006). The state of a Stream is the Projection of its events.

## Accounts and Services

| Service | `origin` | `group` |
| --- | --- | --- |
| `librus` | Not used | Not used |
| `activenow` | Not used | Name of the profile of the Child |
| `edusky` | Address of the organizer | Text of the group name in the app |
| `mondo` | Address of the parent panel | Text of the Child in the child picker |

See the README of each package for more detail.
