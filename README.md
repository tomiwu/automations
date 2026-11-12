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
| `packages/payments-watch` | Payment notices with a transfer QR code and the payments dashboard |
| `tools/admin` | Admin CLI to add families, children, accounts and recipients |
| `tools/privacy-check` | Privacy gate: hashed private words and heuristics for personal data |

Docs: [architecture](docs/architecture.md), [Supabase setup](docs/supabase-setup.md), [Kody deploy](docs/kody-deploy.md), [adding a Child](docs/adding-a-child.md), [running on Node](docs/running-on-node.md). See [the PRD](docs/PRD.md) for the plan.

## Architecture

A Watcher reads a Service (Librus, ActiveNow, Edusky, Mondo) for each Account of a Child and records new Items through the `StorageAdapter`. Each new Item makes Outbox entries, one for each Recipient. The Notifier sends the Outbox entries to Telegram in the language of the Recipient. Watcher code uses the `Runtime` interface (fetch, secrets, time, logs, schedules), so the same code runs on Kody and on plain Node. See [docs/architecture.md](docs/architecture.md) and the ADRs in [docs/adr/](docs/adr). The words are in [CONTEXT.md](CONTEXT.md).

## Run it locally with the synthetic fixtures

```sh
npm ci
npm test
```

All tests use fakes and invented data (`Child One`, `Example School`, chat ID `1000001`). They need no account at a Service, no Supabase project, no Telegram bot and no network. `packages/librus-data/src/fixtures.ts` and `examples/seed.example.json` hold the fictional Family. `npm run test:sql:local` runs the SQL tests on a throwaway Postgres container.

## Configure your own Family

1. Make the database: [docs/supabase-setup.md](docs/supabase-setup.md).
2. Copy [examples/seed.example.json](examples/seed.example.json) to a file out of the repository (`seed.json` is git-ignored), enter your data and import it with the admin CLI. Or add the rows one by one: [docs/adding-a-child.md](docs/adding-a-child.md).
3. Enter the secret values in the secret store of your platform under the NAMES of your seed file. For plain Node, copy `.env.example` to `.env` (git-ignored): [docs/running-on-node.md](docs/running-on-node.md). For Kody: [docs/kody-deploy.md](docs/kody-deploy.md).

All Family configuration is in the database. The code has no hard-coded person. The repository contains no personal data. The database holds only the NAMES of secrets. The secret values stay in the secret store of the platform. See `examples/` for generic secret names such as `CHILD1_LIBRUS_LOGIN`.

## Privacy gate

`npm run privacy` checks the tracked files for private words (salted hashes only, the plain list stays on your computer), e-mail addresses, phone numbers, account numbers, private IP addresses, Telegram chat IDs and tokens. It prints places and categories, never values. See [tools/privacy-check/README.md](tools/privacy-check/README.md). If you fork the project for your own Family, add your own private words before your first commit.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run crap   # fails if a function has a CRAP score of 6 or more
npm run test:sql:local   # migration changed: SQL tests on a throwaway postgres:17
```

When you change a file in `supabase/migrations`, run `npm run test:sql:local` before the push. It needs podman or docker, and `psql` in the `PATH`.

Run `scripts/install-hooks.sh` one time in a new clone. It installs the pre-commit hook (gitleaks, the privacy check and the typecheck of the staged workspaces) and the pre-push hook (the full `scripts/ci-local.sh` on each commit of a push, about 2.5 minutes, with a cache of green commits) for all worktrees. `--no-verify` is not allowed. See `CONTRIBUTING.md`.

Before a push, run `npm run check`. It runs typecheck, test, crap, the privacy check and gitleaks (when gitleaks is installed) in order, stops at the first failure and names the failed step. `npm run crap:changed` runs crap only in the workspaces that changed against `origin/main` (`-- --dry-run` prints the list, `-- --base <ref>` changes the base). See `tools/dev-checks`.

Requirements: Node 22 or later. The repository uses npm workspaces.

A new git worktree needs its own `npm ci`. With a `node_modules` linked from another checkout, the workspace packages come from that checkout and the tests run old code. Each workspace's vitest stops at once with "workspace packages resolve outside this checkout: run npm ci here" (`vitest.global-setup.ts`, `tools/test-setup`).

## Optional agent loop of the maintainer

`.sandcastle/` and `scripts/sandcastle-loop/` are optional development tooling of the maintainer. They run an agent loop that works on the issues of the repository. They are not necessary to run the packages, the tests or the admin CLI. You can ignore them.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [SECURITY.md](SECURITY.md). [docs/public-release.md](docs/public-release.md) tells how the public repository is made from a private one.

## License

MIT. See [LICENSE](LICENSE).
