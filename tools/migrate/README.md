# migrate

`apply.sh` applies the files of `supabase/migrations/*.sql` in name order with `psql -v ON_ERROR_STOP=1`.

- It reads the connection string from `SUPABASE_DB_URL`. If the variable is empty, it prints a message and exits 0. It never prints the connection string.
- It creates `public.schema_migrations (name text primary key, applied_at timestamptz default now())` if needed. The role `automations_watcher` has no access to this table.
- Each file and its record run in one transaction. A file that is already recorded is skipped.

## Run

    SUPABASE_DB_URL=<connection string> tools/migrate/apply.sh [migrations-dir]

## Test

Set `TEST_DATABASE_URL` to a superuser connection string of an empty test database, then run `npm test`. The test runs the script twice and checks that the second run applies nothing. Without `TEST_DATABASE_URL`, the database tests are skipped.
