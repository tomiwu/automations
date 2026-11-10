# @automations/librus-data

`StorageAdapter` is the interface for Items, the Outbox and config reads.

| Operation | Result |
| --- | --- |
| `knownItemIds(familyId, watcher)` | `Set` of Item IDs that the Watcher saw |
| `listItems(familyId, watcher)` | Items, oldest first |
| `recordItems(familyId, watcher, ids)` | Number of new Items. Known IDs are ignored |
| `enqueueNotification(entry)` | `true` if inserted, `false` if the `key` exists |
| `pendingNotifications(familyId)` | Undelivered Outbox entries, oldest first |
| `markDelivered(key)` | Sets `deliveredAt` |
| `enqueueNotifications(entries)` | Like `enqueueNotification` for many entries in one request. Returns the number of new entries |
| `markDeliveredMany(keys)` | Like `markDelivered` for many keys in one request |
| `recordDetails(rows)` | Stores the content of Items in batches. Returns the number of new rows. Same content is ignored; changed content adds a row and the old row stays. It also appends `ItemRecorded` or `ItemChanged` events to the Journal (stream `item:<scope>:<sourceId>`) |
| `listDetails(familyId, { childId?, from?, to?, since? })` | Stored details, oldest first. They are read from the Item events of the Journal; `firstSeen` is `recordedAt`. `from` and `to` are `YYYY-MM-DD`. Details are never purged |
| `appendEvents(events)` | Appends Journal events in batches of 100 rows at most. A conflict on `(family_id, stream, seq)` is an error. Returns the number of new events |
| `listHeads(familyId, filter?)` | The Head (last event) of each stream, read from the view `journal_heads` in one request. The filter has `childId`, `kinds`, `streams`, `from`, `to` (included) and `before` (not included). For a month use `monthRange("YYYY-MM")`: `{ from, before }` with the first day of the month and of the next month. Never build a month end like `-31`: Postgres answers 400 for a day that does not exist |
| `listEvents(familyId, filter?)` | The Journal events that match the filter, oldest first. The filter also has `since` |
| `loadConfig(familyId)` | `Config` of the Family, read in one request |
| `listFees(familyId)` | Fees of the Family. The Watcher cannot change them |
| `upsertPayment(payment)` | Makes a `pending` Payment and returns it. A Payment for the same Fee and month is returned as it is |
| `listPayments(familyId)` | Payments of the Family, oldest first |
| `setPaymentStatus(id, status, decidedBy)` | Sets `paid` or `skipped`, `decidedAt` and `decidedBy` of a `pending` Payment. Returns `false` if nothing changed |

## Journal

`src/journal.ts` holds the pure core of the event journal (ADR 0006). It has no network code.

- `contentHash(value)` gives a stable hash of a value.
- `planEvents` compares the observed entities with the Heads and gives only the change events. No change gives no event. An entity in the read window that is not in a successful download gets a `...Vanished` event.
- `checkEvent` makes the `CheckCompleted` event of one successful pass.
- `projectStream(events)` and `projectHeads(heads)` give the Projection (the state of a stream). Each event carries the whole state, so the last event gives it.
- `matchesJournalFilter` is the filter that the memory adapter and the fake PostgREST use.

**Append-only rule.** A Journal event is never changed or deleted. The role `automations_watcher` has only `select` and `insert` on `journal_events`. A trigger rejects `update`, `delete` and `truncate` for all roles. `StorageAdapter` has no method that changes or removes an event, and a test checks that the Supabase adapter never sends `PATCH` or `DELETE` to `journal_events`. `purgeDelivered` never touches the table.

`createMemoryStorage` is the in-memory fake. It uses no network.

`runStorageContract` is the contract test suite. Each adapter must pass it.
Import it from `@automations/librus-data/contract` and give it a harness factory.

`createSupabaseStorage` is the adapter for the PostgREST API of Supabase. It uses plain `fetch`.
`supabaseStorageFromRuntime(runtime, url?)` uses the secret `SUPABASE_KEY`. On Kody the URL comes from the deployment config; locally it falls back to the secret `SUPABASE_URL`.
`keepalive()` reads one row, so the free project does not pause.

The adapter runs the contract suite against `createFakePostgrest`, an in-memory fake of the PostgREST API.

`src/postgrest.test.ts` runs the same suite against a real PostgREST server on a Postgres database. It runs only if
`POSTGREST_TEST_URL`, `POSTGREST_TEST_KEY` (a JWT for the role `automations_watcher`) and
`TEST_DATABASE_URL` (a superuser connection string, the migration applied) are set. The `psql` program must be in the `PATH`.

## Migration from Kody

`exportKodyData(storage, watchers)` is the core of the one-time Kody export job.
It reads `items:<watcher>` for each Watcher and `outbox` from Kody package storage.
It skips old Outbox entries that have no chat ID. Run it in a Kody job and save the result as JSON.

`importKodyData(storage, familyId, data)` writes the Items and Outbox entries to a `StorageAdapter`.
Then it compares the counts per Watcher and for pending Outbox entries. It throws `CountCheckError` on a difference.
The import is safe to run again. The `first_seen` time of an imported Item is the time of the import.

To run the import on the owner's computer:

```
SUPABASE_URL=... SUPABASE_KEY=... FAMILY_ID=... npx tsx packages/librus-data/src/import-cli.ts export.json
```

The command exits with code 1 if a count differs. The target must have no other Items for the Watchers and no other pending Outbox entries.
