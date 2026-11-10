# Deploy on Kody

For the big picture, see `docs/overview.md`.

Do the steps in `docs/supabase-setup.md` first.

## Packages

Four packages run as Kody packages. All are private.

| Package | Jobs (in `package.json`, `kody.jobs`) |
| --- | --- |
| `@tomiwu/librus-watch` | `scheduled-check` (04:30 and 12:30 UTC) |
| `@tomiwu/activities-watch` | The scheduled pass and the exports. See its README. |
| `@tomiwu/payments-watch` | `scheduled-check` (08:00 UTC) |
| `@tomiwu/kradziejka` | No jobs. Two inbound webhooks and one register webhook. See its README. |

Kody reads cron expressions in UTC. Do not set a cron time zone.
Each watcher package exports entry files (`./scheduled`, `./configure` and the exports). `@tomiwu/kradziejka` exports webhooks instead of jobs. Only the entry files import the Kody runtime.

## Deploy workflow behaviour

- `Deploy to Kody` runs after CI is green on main. A newer run cancels an older one (`cancel-in-progress: true`). The newer run deploys every package from the newer commit.
- Each job has `timeout-minutes: 30`, the check step 10 and the publish step 20.
- The publish check retries on 5xx and timeouts (`tools/kody-deploy/kody-check.mjs`). The check of `librus-watch` takes about 60 s and can end in a gateway 503 although the tree is good. A deploy then goes on with a warning, because publish runs the same checks.
- A failed or cancelled job writes `not deployed: <package> at <sha>` as an error and in the job summary.

## Secrets and credentials

- Kody secret `SUPABASE_KEY` (the watcher key). It is sent as the literal `{{secret:SUPABASE_KEY}}`. Allowed host: `<ref>.supabase.co`, header placement.
- Kody secret `JEV_API_KEY`, used by `@tomiwu/kradziejka`. It is sent as the literal `{{secret:JEV_API_KEY}}`. Allowed host: `api.getjevai.com`, header placement.
- Kody secret `TELEGRAM_BOT_TOKEN`, used by `@tomiwu/telegram` for the Librus polling bot (`librus-watch` and `activities-watch`).
- Kody secret `telegramBotToken-kradziejka`, used by `@tomiwu/kradziejka` through `@tomiwu/telegram` (`secretName: "telegramBotToken-kradziejka"`). This is a separate BotFather bot. Host: `api.telegram.org`.
- Bot webhook keys are not Kody secrets. `@tomiwu/kradziejka` stores them as AES-256-GCM ciphertext in `kradziejka_bots`. Kody accepts only literal secret names, so one secret cannot hold one key per bot.
- The service logins (Librus, ActiveNow, Edusky, Mondo, and `EDUSKY_CLIENT_SECRET`) are rows in the Supabase table `credentials`, encrypted with AES-256-GCM. Add or change one with `admin set-credential --family <id> --name <NAME>` on your own computer (it asks for the value without echo and needs `CREDENTIAL_KEY`). New Accounts need no code change and no Kody secret.

## Deployment config

After the first deploy, call `./configure` of each package yourself with `{ supabaseUrl, familyId, credentialKey }`. `@tomiwu/kradziejka` also needs `allowlist` and `adminToken`. The key comes from `admin new-credential-key`; keep it in a password manager. Do not pass it through an agent. Rotate with `admin rotate-credential-key` (needs `CREDENTIAL_KEY` and `NEW_CREDENTIAL_KEY`), then call `./configure` again.

The key cannot be a Kody secret. Kody never gives a secret value to package code: a secret is only an opaque `{{secret:NAME}}` placeholder that Kody fills in when a `fetch` sends it to an allowed host. AES-GCM decryption needs the raw key in the code, so the key stays in the package storage (`./configure`).

To check a stored login without showing it, run `printf %s "$NAME" | admin verify-credential --family <id> --name NAME` with `CREDENTIAL_KEY` set. It prints only `match`, `no match`, `does not decrypt with this CREDENTIAL_KEY`, or `not stored`. To store every login again from `.env`, run `setup-credentials --force` in a window with the same `CREDENTIAL_KEY` that `./configure` got.

Security: a leak of the database alone gives only ciphertext; a leak of the package storage alone gives a key without data. Anyone who can change and publish these Kody packages can read the decrypted values, as with any code that logs in.

## Fetch budget

The Kody free plan allows 2500 outbound fetches in a UTC week. Each run logs its fetch count.

- The journal step of a scheduled pass adds about 2 to 4 Supabase fetches for each Child and pass: the read of the Heads, the append, and the check stream.
- The stored exports read Supabase only: `./stored-lessons` uses 4 fetches at most, `./stored-sessions` 3, `./stream-history` uses 1. They make no Librus or app fetch.
- The calendar sync must use the stored exports. It must not use `./lessons`, `./calendar`, `./upcoming` and `./sessions`. Those exports log in to the Services, use many fetches and stay for manual use.
- Journal rows are never purged, so the table grows. The estimate is far below the free Supabase limit (ADR 0006).

### Reserve for payments-watch

Payment reminders are time-critical, so `payments-watch` must not lose the weekly fetches to the other jobs.

- Kody does not give the used fetch count to package code. So `librus-watch` and `activities-watch` keep a ledger in their package storage (key `fetch-ledger`): the fetches of the package in the current UTC week, and the UTC day when a fetch failed with `EntitlementLimitError: Plan limit reached`. The ledger is an estimate: it does not see other packages or agent calls.
- When `2500 - used` is below the reserve (or the plan limit was hit today), a scheduled pass skips its optional parts and logs one line `budget reserve: skipped <parts>`. `librus-watch` skips the grades, messages, announcements, trips, absences and meetings Watchers. `activities-watch` uses the ActiveNow cache and does not fetch ActiveNow again. Homework, lessons, substitutions, free days, the Journal and the Morning report always run.
- `paymentPhotos` (boolean, default `false`) in the deployment config makes `payments-watch` send the Payment Notifications and reminders as QR photos with the Paid and Skip buttons (see `packages/payments-watch/README.md`). Turn it on only after one test `sendPhoto` through the Kody `telegram` capability worked.
- The reserve is `fetchReserve` in the deployment config (`./configure`), a whole number from 0 to 2500. The default is 150.
- When a fetch of `payments-watch` fails on the plan limit, the pass does not fail. A Fee page is not read again in the pass, the amounts come from the config (`fees.amounts`), the Payments and Notifications are still made, and each Recipient gets at most one "page source skipped: fetch cap" notice a day. `CheckCompleted` is appended only when the pass finished.
- Owner option (not done by the code): move the `payments-watch` job before the other jobs, for example `0 4 * * *` UTC, so it runs before `librus-watch` and `activities-watch` (`30 4,12 * * *` UTC) use the budget of the day. This is a Kody job change. Only the owner does it.

## Telegram

The delivery uses the external `telegram` package (`@tomiwu/telegram`, an unchanged copy of `@kody/telegram`). Install it in Kody before the first deploy.

## Deploy steps

1. Run `npm ci`, `npm run typecheck`, `npm test` and `npm run crap`. All must pass.
2. Deploy the packages with the same names as the previous version.
3. Do a test read: call an export, for example `children` of `@tomiwu/librus-watch`.
4. Keep the previous version. To roll back, deploy it again. Only one version runs at a time.

The first run of each scope is a silent Baseline, so the first deploy sends no old Items.

## Deploy from CI

The workflow `.github/workflows/deploy-kody.yml` runs after CI is green on `main` and can be started by hand.

1. `tools/kody-stage/stage.mjs` builds a self-contained tree for each package. Kody gets dependencies from the public npm registry, so the private `@automations/*` packages are copied into `vendor/` and their imports are rewritten. Test files are left out.
2. The job sends the tree to the Kody publish checks (`packageCheck`). This saves nothing.
3. Only when the repository variable `KODY_DEPLOY_ENABLED` is `true` (and a manual run is not a dry run): the job pushes the tree to the Kody package repo (`packageGetGitRemote`, a fast-forward push) and runs `kody package publish`. If publish returns `status: "dispatched"`, the job polls `workflowRunList` for that `workflow_id` until the durable run is terminal and fails the job on `errored` (printing `last_error`). One re-publish runs after a durable failure, because Kody says a re-run can repair missing artifacts.

Setup (the owner does this, never an agent):

- Create a Kody API token (`tokenCreate`, lifetime `long`) with the scopes `package:read`, `package:write`, `package:publish`, `org:read`. Add it in GitHub as the environment secret `KODY_DEPLOY_TOKEN` (environment `kody`). A long token lasts at most 90 days and expires after 14 days without use, so renew it.
- Set the repository variable `KODY_DEPLOY_ENABLED` to `true` when you want real deploys.

Roll back by deploying the previous version again (see Deploy steps). The workflow never changes Kody secrets and never changes the visibility of a package.

## Key rotation and redeploys

`./configure` writes the config (with the key) to the package storage. Each job and webhook reads it again on every run (`entryDeps()` calls `loadDeploymentConfig(kodyStorage())`). Nothing caches it at module load. So a new key takes effect on the next run; you do not need to publish the package code again.

A credential "does not decrypt" only when the key, the Family ID or the name differ from encryption time, or the row was changed. The value itself (quotes, `@`, a new line) cannot cause it. The old flow had two scripts that each took `CREDENTIAL_KEY` from a different place (the shell for `setup-credentials`, `.env` for `kody-configure`), and skipped stored rows without `--force`. So rows could have a different key from the packages. `tools/admin/rekey.sh` uses one key for all steps and verifies it.
