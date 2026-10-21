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
2. On your own computer, run `admin make-watcher-key`. It signs a JWT for the role `automations_watcher` with the JWT secret.
3. Keep the result. Do not give it to an agent.

The `service_role` key stays on your computer. Only the admin CLI uses it. Never enter it in Kody.

## 4. Enter the Kody secrets

Enter these secrets in Kody and approve them for the host:

| Secret | Value |
| --- | --- |
| `SUPABASE_URL` | The project URL (`https://<project-ref>.supabase.co`). |
| `SUPABASE_KEY` | The key from step 3. |

For each Account, also enter the secrets that the Account names, for example `CHILD1_LIBRUS_LOGIN` and `CHILD1_LIBRUS_PASSWORD`. The database holds only the names.

## 5. Daily purge

A scheduled job calls `purgeDelivered(30)` each day. It uses the role `automations_watcher`. The RLS policy allows the delete only for entries that were delivered more than 30 days ago.

## Tests

CI applies the migration to a Postgres service container and tests the RLS policies. See `tools/sql-tests/README.md`.
