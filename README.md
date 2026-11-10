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
npm run test:sql:local   # migration changed: SQL tests on a throwaway postgres:17
```

When you change a file in `supabase/migrations`, run `npm run test:sql:local` before the push. It needs podman or docker, and `psql` in the `PATH`.

Before a push, run `npm run check`. It runs typecheck, test, crap and gitleaks (when gitleaks is installed) in order, stops at the first failure and names the failed step. `npm run crap:changed` runs crap only in the workspaces that changed against `origin/main` (`-- --dry-run` prints the list, `-- --base <ref>` changes the base). See `tools/dev-checks`.

Requirements: Node 22 or later. The repository uses npm workspaces.

A new git worktree needs its own `npm ci`. With a `node_modules` linked from another checkout, the workspace packages come from that checkout and the tests run old code. Each workspace's vitest stops at once with "workspace packages resolve outside this checkout: run npm ci here" (`vitest.global-setup.ts`, `tools/test-setup`).

## License

MIT. See `LICENSE`.
