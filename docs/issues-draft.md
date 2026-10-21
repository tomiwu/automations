# Draft issues for tomiwu/automations (not created on GitHub)

Each issue has the label `Sandcastle` and the given priority label. `D<n>` is a draft number. Replace `#D<n>` with the real number when you create the issues. Create them in this order. Issues marked **(owner)** are not for Sandcastle; the owner or the agent does them.

## D1: Repo skeleton with npm workspaces, MIT and CI
Labels: Sandcastle, priority: high

Make the root `package.json` with workspaces `packages/*` and `tools/*`. Add `LICENSE` (MIT), `README.md`, `tsconfig.base.json`, an empty `packages/shared`. Add `.github/workflows/ci.yml`: `npm ci`, typecheck and tests for each workspace, gitleaks on full history, and the deny-list grep step from a secret (skip if empty). See PRD Part A.

Acceptance: CI is green on a PR. gitleaks runs.

## D16: Sandcastle setup in the monorepo
Labels: priority: high **(agent)**

Blocked by #D1

Copy `.sandcastle` from `kody` with generic prompts and the workspace commands. No names, no paths. Do this right after D1. The Sandcastle loop starts only after this issue is merged.

## D2: shared: Runtime interface with Kody and Node implementations
Labels: Sandcastle, priority: high

Blocked by #D1

Add `Runtime` (`fetch`, `secret`, `now`, `log`, schedule). Add `kodyRuntime` and `nodeRuntime`. Add a fake runtime for tests. See PRD Part B.

Acceptance: unit tests with the fake. Only `kody.ts` imports `kody:runtime`.

## D3: shared: config types, validation and common helpers
Labels: Sandcastle, priority: high

Blocked by #D2

Add the types `Family`, `Child`, `Account`, `Activity`, `Recipient`. Add validation (PRD Part E, item 4). Move the duplicated code from the two watchers here: HTTP session with cookies, time zone and date helpers, schedule helpers, no-input check.

Acceptance: tests for validation errors per Account.

## D4: shared: i18n catalogs pl and en
Labels: Sandcastle, priority: medium

Blocked by #D1

Add `t(language, key, params)` and the catalogs `pl`, `en`. The catalogs hold all user-facing text, including the morning report and the after-school section. Add a test that both catalogs have the same keys. See PRD Part F.

## D5: Supabase SQL migration: schema, RLS, restricted role, purge
Labels: Sandcastle, priority: high

Blocked by #D1

Add `supabase/migrations/0001_init.sql`. It is idempotent. Tables, RLS policies and role `automations_watcher` as in PRD Part D. Add `docs/supabase-setup.md`: create the project in Frankfurt, run the SQL, make the role key, enter the Kody secrets.

Acceptance: CI starts a Postgres service container, applies the SQL and tests the RLS policies: `automations_watcher` can read config tables, cannot write them, can insert `items`, and can update only `delivered_at` in `outbox`.

## D6: librus-data: StorageAdapter, in-memory fake and contract tests
Labels: Sandcastle, priority: high

Blocked by #D3

Define `StorageAdapter` (PRD Part C, item 1). Keep the current public function names and inputs. Add the in-memory fake and a contract test suite.

## D7: librus-data: SupabaseStorage over PostgREST
Labels: Sandcastle, priority: high

Blocked by #D5, #D6

Implement the adapter with fetch and `SUPABASE_URL`, `SUPABASE_KEY`. Idempotent enqueue, `purgeDelivered`, `loadConfig`, keepalive read. Run the contract suite against a recorded fake HTTP server and against the CI Postgres service container as `automations_watcher`.

## D8: librus-watch: port to the monorepo with config from storage
Labels: Sandcastle, priority: high

Blocked by #D7, #D4

Port the Librus watcher, lessons and upcoming exports and the morning report. Remove all config from the code. Load Children with `has_librus` and their Librus Accounts with `loadConfig`. Render all Notifications and the morning report from the pl/en catalogs per Recipient language. Fixtures use invented names only. Package name `@tomiwu/librus-watch`.

## D9: activities-watch: port ActiveNow and Edusky with config from storage
Labels: Sandcastle, priority: high

Blocked by #D8

Port the ActiveNow and Edusky watchers, the sessions export, the after-school section (text from the pl/en catalogs) and mail compare. Activities and Accounts come from storage. Package name `@tomiwu/activities-watch`.

## D10: activities-watch: port the Mondo watcher
Labels: Sandcastle, priority: medium

Blocked by #D9

Port the Mondo watcher with its current fixes. Use recorded fake pages with invented data.

## D11: exports with childId and the children export
Labels: Sandcastle, priority: medium

Blocked by #D9

Add `childId` and the Child name to `lessons`, `sessions` and `upcoming`. Add the export `children` (`id`, `name`, `calendar_id`). See PRD Part I.

## D12: daily outbox purge and keepalive job
Labels: Sandcastle, priority: medium

Blocked by #D7

Add a scheduled job that calls `purgeDelivered(30)` each day. Make sure each watcher run does the keepalive read.

## D13: tools/admin CLI
Labels: Sandcastle, priority: medium

Blocked by #D7

Commands `add-family`, `add-child`, `add-account`, `add-activity`, `add-recipient`, `list`, `disable-account`, `import-seed <file>`, `make-watcher-key`. Uses `SUPABASE_SERVICE_ROLE_KEY` from the environment. It never takes secret values. `add-account` prints the Kody secret names to enter. `make-watcher-key` signs a JWT for `automations_watcher` with the project JWT secret and prints it once; the owner enters it in Kody as `SUPABASE_KEY`. Document it in `docs/supabase-setup.md`. See PRD Part G.

## D14: migration: export Kody librus-data and import to Supabase with count checks
Labels: Sandcastle, priority: high

Blocked by #D7

A one-time Kody export job for Items and Outbox. An import script with count checks per Watcher and for pending Outbox entries. It fails on a difference. See PRD Part H, items 1 and 2.

## D15: docs and examples
Labels: Sandcastle, priority: low

Blocked by #D13

`docs/`: architecture, Kody deploy, Supabase setup, adding a child, running on Node. `examples/`: `seed.example.json` with generic secret names `CHILD1_*` and `CHILD2_*` secret names, example Recipients in `pl` and `en`.

## D17: switch Kody to the monorepo packages
Labels: priority: high **(owner/agent)**

Blocked by #D8, #D9, #D10, #D11, #D12, #D14

The owner seeds the config with `admin import-seed` from the seed file on the owner's computer, and enters `SUPABASE_KEY` from `make-watcher-key`. Keep the existing Kody secret names. Run the import. Save the current Kody versions for rollback. Deploy, test read, check Telegram in each language. Point the calendar routines to the `children` export.

## D18: archive tomiwu/kody and review for public
Labels: priority: low **(owner)**

Blocked by #D17

After one week of stable runs, archive `tomiwu/kody`. Run gitleaks and the deny-list on the full history. The owner reviews and decides to make the repo public.
