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
| `purgeDelivered(olderThanDays)` | Number of removed Outbox entries |
| `loadConfig(familyId)` | `Config` of the Family |

`createMemoryStorage` is the in-memory fake. It uses no network.

`runStorageContract` is the contract test suite. Each adapter must pass it.
Import it from `@automations/librus-data/contract` and give it a harness factory.

`createSupabaseStorage` is the adapter for the PostgREST API of Supabase. It uses plain `fetch`.
`supabaseStorageFromRuntime` reads the secrets `SUPABASE_URL` and `SUPABASE_KEY` from the `Runtime`.
`keepalive()` reads one row, so the free project does not pause.

The adapter runs the contract suite against `createFakePostgrest`, an in-memory fake of the PostgREST API.

`src/postgrest.test.ts` runs the same suite against a real PostgREST server on a Postgres database. It runs only if
`POSTGREST_TEST_URL`, `POSTGREST_TEST_KEY` (a JWT for the role `automations_watcher`) and
`TEST_DATABASE_URL` (a superuser connection string, the migration applied) are set. The `psql` program must be in the `PATH`.
