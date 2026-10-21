# Supabase setup

Follow these steps one time for each deployment.

## 1. Create the project

1. Sign in to Supabase and create a new project.
2. Select the region Frankfurt (`eu-central-1`).
3. Save the database password in your password manager. Do not put it in the repository.

## 2. Run the SQL

1. Open the SQL editor of the project.
2. Paste the content of `supabase/migrations/0001_init.sql` and run it.
3. You can run the file again. It is idempotent.

The migration makes the tables, the RLS policies and the role `automations_watcher`. The role can:

- read the config tables (`families`, `children`, `accounts`, `activities`, `recipients`);
- read and insert `items`;
- read and insert `outbox` entries, update only `outbox.delivered_at`, and delete `outbox` entries that were delivered more than 30 days ago.

## 3. Make the role key

1. Copy the JWT secret of the project (Project settings, API).
2. On your own computer, set `SUPABASE_JWT_SECRET` in the environment and run `admin make-watcher-key`. It signs a JWT for the role `automations_watcher` with the JWT secret and prints it one time.
3. Enter the result in Kody as `SUPABASE_KEY` (step 5). Do not give it to an agent.

The `service_role` key stays on your computer. Only the admin CLI uses it. Never enter it in Kody.

## 4. Fill the config with the admin CLI

On your own computer, set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in the environment. Then run the commands in this order. See `tools/admin/README.md` for all options.

1. `admin add-family --name "Example Family"`
2. `admin add-child --family <family-id> --name "Child One" --has-librus`
3. `admin add-account --family <family-id> --child <child-id> --service librus --login-secret CHILD1_LIBRUS_LOGIN --password-secret CHILD1_LIBRUS_PASSWORD`
4. `admin add-recipient --family <family-id> --chat-id 1000001 --language en --children <child-id>`

The CLI takes secret NAMES only. `add-account` prints the Kody secrets that you must enter in step 5. To load a seed file, run `admin import-seed <file>`. Use `admin list` to see the config and `admin disable-account --id <account-id>` to stop an Account.

## 5. Enter the Kody secrets

Enter these secrets in Kody and approve them for the host:

| Secret | Value |
| --- | --- |
| `SUPABASE_URL` | The project URL (`https://<project-ref>.supabase.co`). |
| `SUPABASE_KEY` | The key from step 3. |

For each Account, also enter the secrets that the Account names, for example `CHILD1_LIBRUS_LOGIN` and `CHILD1_LIBRUS_PASSWORD`. The database holds only the names.

## 6. Daily purge

A scheduled job calls `purgeDelivered(30)` each day. It uses the role `automations_watcher`. The RLS policy allows the delete only for entries that were delivered more than 30 days ago.

## Tests

CI applies the migration to a Postgres service container and tests the RLS policies. See `tools/sql-tests/README.md`.
