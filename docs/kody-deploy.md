# Deploy on Kody

Do the steps in `docs/supabase-setup.md` first.

## Packages

Two packages run as Kody packages. Both are private.

| Package | Jobs (in `package.json`, `kody.jobs`) |
| --- | --- |
| `@tomiwu/librus-watch` | `scheduled-check` (07:00 and 18:00), `daily-purge` (03:30) |
| `@tomiwu/activities-watch` | The scheduled pass and the exports. See its README. |

The time zone of a schedule must be the time zone of the Family.
Each package exports entry files (`./scheduled`, `./purge` and the exports). Only the entry files import the Kody runtime.

## Secrets

Enter these secrets in Kody and approve them for the host:

| Secret | Use |
| --- | --- |
| `SUPABASE_KEY` | Key of the role `automations_watcher` |
| `TELEGRAM_BOT_TOKEN` | Token of the Telegram bot |
| `EDUSKY_CLIENT_SECRET` | Client secret of the Edusky web app (only for Edusky) |
| Account secrets | The NAMES in `accounts.login_secret` and `accounts.password_secret`, for example `CHILD1_LIBRUS_LOGIN` |

Kody never gives a secret value to code. The code sends `{{secret:NAME}}` and Kody fills it in for the allowed hosts of the secret, so each secret needs its host: `SUPABASE_KEY` → `<ref>.supabase.co`, the Librus secrets → the Librus hosts, the Activity secrets → the host of their app. Secrets in a form body need body placement.

## Deployment config (not secret)

The Supabase project URL and the Family ID are plain config in the storage of each package. After the first deploy, call `./configure` of `@tomiwu/librus-watch` and of `@tomiwu/activities-watch` with `{ supabaseUrl, familyId }`. They are not in the repository.

Do not put a secret value in the repository, in a file or in a chat with an agent.

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
3. Only when the repository variable `KODY_DEPLOY_ENABLED` is `true` (and a manual run is not a dry run): the job pushes the tree to the Kody package repo (`packageGetGitRemote`, a fast-forward push) and runs `kody package publish`.

Setup (the owner does this, never an agent):

- Create a Kody API token (`tokenCreate`, lifetime `long`) with the scopes `package:read`, `package:write`, `package:publish`, `org:read`. Add it in GitHub as the environment secret `KODY_DEPLOY_TOKEN` (environment `kody`). A long token lasts at most 90 days and expires after 14 days without use, so renew it.
- Set the repository variable `KODY_DEPLOY_ENABLED` to `true` when you want real deploys.

Roll back by deploying the previous version again (see Deploy steps). The workflow never changes Kody secrets and never changes the visibility of a package.
