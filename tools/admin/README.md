# admin

The admin CLI for the owner. It edits the Family config in Supabase and makes the watcher key. Run it on your own computer.

## Environment

| Variable | Use |
| --- | --- |
| `SUPABASE_URL` | The project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | The `service_role` key. Needed by all commands except `make-watcher-key`. |
| `SUPABASE_JWT_SECRET` | The JWT secret of the project. Needed by `make-watcher-key` only. |

The CLI never takes a secret value as an argument. `--login-secret` and `--password-secret` take secret NAMES, such as `CHILD1_LIBRUS_LOGIN`. The CLI refuses anything else.

## Run

`node --experimental-strip-types tools/admin/src/cli.ts <command> [options]`

## Commands

| Command | Options |
| --- | --- |
| `add-family` | `--name`, `--timezone` (default `UTC`), `--language` (`pl` or `en`, default `en`) |
| `add-child` | `--family`, `--name`, `--has-librus`, `--calendar-id` |
| `add-account` | `--family`, `--child`, `--service`, `--login-secret`, `--password-secret`, `--origin`, `--group` |
| `add-activity` | `--family`, `--child`, `--name`, `--weekday` (1 = Monday to 7 = Sunday), `--start`, `--end`, `--account`, `--place` |
| `add-recipient` | `--family`, `--chat-id`, `--language`, `--children` (comma-separated Child IDs) |
| `set-fee` | `--family`, `--child`, `--organizer`, `--recipient-name`, `--account` (NRB, 26 digits, checksum checked), `--title`, `--due-day` (1-28), `--nip` (optional, checksum checked), `--notify-day` (default 10, less than due day), `--reminder-day` (default 14), `--amounts` (`YYYY-MM=grosze,...`), `--source-url`, `--account-id` |
| `list-fees` | `--family` (optional) |
| `payments-consistency` | `--family`. Read only. Compares the Journal heads of the `payment:` streams with the `payments` table. It prints each difference (stream, Payment id, field) and no amounts. It fails when there is a difference. |
| `list` | `--family` (optional) |
| `disable-account` | `--id` |
| `import-seed <file>` | A JSON file with the keys `families`, `children`, `accounts`, `activities`, `recipients`, `fees`. Each value is a list of table rows. |
| `new-credential-key` | None. Prints a new credential key (base64). |
| `set-credential` | `--family`, `--name`, `--stdin` (read the value from standard input instead of a prompt). Needs `CREDENTIAL_KEY`. |
| `verify-credential` | `--family`, `--name`. Reads a value from standard input and compares it with the stored credential. Prints only `match`, `no match`, `does not decrypt with this CREDENTIAL_KEY` or `not stored`. Needs `CREDENTIAL_KEY`. |
| `list-credentials` | `--family`. Names only. |
| `rotate-credential-key` | `--family`. Needs `CREDENTIAL_KEY` and `NEW_CREDENTIAL_KEY`. |
| `rekey` | `--family`. Encrypts every credential again with `NEW_CREDENTIAL_KEY` (value from the environment, else the old row opened with `CREDENTIAL_KEY`, else a hidden prompt), sets the Librus origin where it is empty, and prints only `NAME: ok`, `does not decrypt` or `missing`. Use it through `bash tools/admin/rekey.sh`. |
| `make-watcher-key` | None. Prints a JWT for the role `automations_watcher`. |

Each `add-*` command prints the ID of the new row. `add-account` also prints the Kody secrets that you must enter.

Keep the seed file on your own computer. Never put it in the repository.

## Rotate the credential key in one step

From the repo root: `bash tools/admin/rekey.sh`. It loads `.env`, makes a new key, encrypts all credentials, writes the new key to `.env` (old file in `.env.bak`), calls `./configure` of each Kody package with the same key, and prints a status per name. It never prints a value. Run it again if a step fails.

Put values in `.env` in single quotes (`NAME='value'`). The script sources `.env`, so an unquoted `$`, space or `#` changes the value.

With `WITH_PAYMENTS=1`, the script also saves the payments-watch Dashboard allowlist. It reads `PAYMENTS_DASHBOARD_USER` from `.env` (it asks if missing) and `PAYMENTS_DASHBOARD_TOKEN` (it makes one with `openssl rand -hex 24` and appends it to `.env` if missing). Only the SHA-256 digest of the token goes to `./configure`. The script prints the user and says where the token is. It never prints the token or the digest. It stops if the user or the token is empty.
