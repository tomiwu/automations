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
