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
| `add-activity` | `--family`, `--child`, `--name`, `--weekday` (0 to 6), `--start`, `--end`, `--account`, `--place` |
| `add-recipient` | `--family`, `--chat-id`, `--language`, `--children` (comma-separated Child IDs) |
| `list` | `--family` (optional) |
| `disable-account` | `--id` |
| `import-seed <file>` | A JSON file with the keys `families`, `children`, `accounts`, `activities`, `recipients`. Each value is a list of table rows. |
| `new-credential-key` | None. Prints a new credential key (base64). |
| `set-credential` | `--family`, `--name`, `--stdin` (read the value from standard input instead of a prompt). Needs `CREDENTIAL_KEY`. |
| `list-credentials` | `--family`. Names only. |
| `rotate-credential-key` | `--family`. Needs `CREDENTIAL_KEY` and `NEW_CREDENTIAL_KEY`. |
| `make-watcher-key` | None. Prints a JWT for the role `automations_watcher`. |

Each `add-*` command prints the ID of the new row. `add-account` also prints the Kody secrets that you must enter.

Keep the seed file on your own computer. Never put it in the repository.
