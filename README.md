# automations

Generic watchers for school and after-school activity apps. The watchers find new Items (grades, messages, lessons, sessions) and send Notifications to Recipients on Telegram, in the language of each Recipient.

The code runs on the [Kody](https://kody.codes) platform first. A runtime interface lets plain Node run it later.

Start here: [system overview](docs/overview.md).

## Packages

| Path | Purpose |
|---|---|
| `packages/shared` | Runtime interface, config types, i18n catalogs (`pl`, `en`), common helpers |
| `packages/librus-data` | `StorageAdapter` and the Supabase implementation |
| `packages/librus-watch` | Librus watcher, exports and morning report |
| `packages/activities-watch` | ActiveNow, Edusky and Mondo watchers |
| `packages/kradziejka` | Telegram router to Grok bot routines |
| `tools/admin` | Admin CLI to add families, children, accounts and recipients |

Docs: `docs/architecture.md`, `docs/supabase-setup.md`, `docs/kody-deploy.md`, `docs/adding-a-child.md`, `docs/running-on-node.md`. See `docs/PRD.md` for the plan.

## Configuration

All family configuration is in a Supabase database. The repository contains no personal data. The database holds only the NAMES of secrets. The secret values stay in the secret store of the platform. See `examples/` for generic secret names such as `CHILD1_LIBRUS_LOGIN`.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run crap   # fails if a function has a CRAP score of 6 or more
```

Requirements: Node 22 or later. The repository uses npm workspaces.

## License

MIT. See `LICENSE`.
