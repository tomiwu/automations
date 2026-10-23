# Deploy on Kody

Do the steps in `docs/supabase-setup.md` first.

## Packages

Four packages run as Kody packages. All are private.

| Package | Jobs (in `package.json`, `kody.jobs`) |
| --- | --- |
| `@tomiwu/librus-watch` | `scheduled-check` (07:00 and 18:00), `daily-purge` (03:30) |
| `@tomiwu/activities-watch` | The scheduled pass and the exports. See its README. |
| `@tomiwu/payments-watch` | `scheduled-check` (08:00) |
| `@tomiwu/kradziejka` | No jobs. Two inbound webhooks and one register webhook. See its README. |

The time zone of a schedule must be the time zone of the Family.
Each watcher package exports entry files (`./scheduled`, `./purge`, `./configure` and the exports). `@tomiwu/kradziejka` exports webhooks instead of jobs. Only the entry files import the Kody runtime.

## Secrets and credentials

- Kody secret `SUPABASE_KEY` (the watcher key). It is sent as the literal `{{secret:SUPABASE_KEY}}`. Allowed host: `<ref>.supabase.co`, header placement.
- Kody secret `JEV_API_KEY`, used by `@tomiwu/kradziejka`. It is sent as the literal `{{secret:JEV_API_KEY}}`. Allowed host: `api.getjevai.com`, header placement.
- Kody secret `TELEGRAM_BOT_TOKEN`, used by `@tomiwu/telegram` for the Librus polling bot (`librus-watch` and `activities-watch`).
- Kody secret `telegramBotToken-kradziejka`, used by `@tomiwu/kradziejka` through `@tomiwu/telegram` (`secretName: "telegramBotToken-kradziejka"`). This is a separate BotFather bot. Host: `api.telegram.org`.
- Bot webhook keys are not Kody secrets. `@tomiwu/kradziejka` stores them as AES-256-GCM ciphertext in `kradziejka_bots`. Kody accepts only literal secret names, so one secret cannot hold one key per bot.
- The service logins (Librus, ActiveNow, Edusky, Mondo, and `EDUSKY_CLIENT_SECRET`) are rows in the Supabase table `credentials`, encrypted with AES-256-GCM. Add or change one with `admin set-credential --family <id> --name <NAME>` on your own computer (it asks for the value without echo and needs `CREDENTIAL_KEY`). New Accounts need no code change and no Kody secret.

## Deployment config

After the first deploy, call `./configure` of each package yourself with `{ supabaseUrl, familyId, credentialKey }`. `@tomiwu/kradziejka` also needs `allowlist` and `adminToken`. The key comes from `admin new-credential-key`; keep it in a password manager. Do not pass it through an agent. Rotate with `admin rotate-credential-key` (needs `CREDENTIAL_KEY` and `NEW_CREDENTIAL_KEY`), then call `./configure` again.

Security: a leak of the database alone gives only ciphertext; a leak of the package storage alone gives a key without data. Anyone who can change and publish these Kody packages can read the decrypted values, as with any code that logs in.

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
