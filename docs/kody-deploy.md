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
| `SUPABASE_URL` | Project URL |
| `SUPABASE_KEY` | Key of the role `automations_watcher` |
| `FAMILY_ID` | ID of the Family from `admin add-family` |
| `TELEGRAM_BOT_TOKEN` | Token of the Telegram bot |
| `EDUSKY_CLIENT_SECRET` | Client secret of the Edusky web app (only for Edusky) |
| Account secrets | The NAMES in `accounts.login_secret` and `accounts.password_secret`, for example `CHILD1_LIBRUS_LOGIN` |

Do not put a secret value in the repository, in a file or in a chat with an agent.

## Telegram

The delivery uses the external `telegram` package (`@tomiwu/telegram`, an unchanged copy of `@kody/telegram`). Install it in Kody before the first deploy.

## Deploy steps

1. Run `npm ci`, `npm run typecheck`, `npm test` and `npm run crap`. All must pass.
2. Deploy the packages with the same names as the previous version.
3. Do a test read: call an export, for example `children` of `@tomiwu/librus-watch`.
4. Keep the previous version. To roll back, deploy it again. Only one version runs at a time.

The first run of each scope is a silent Baseline, so the first deploy sends no old Items.
