# sql-tests

Tests for `supabase/migrations/*.sql`. They apply the migration to a Postgres database and check the RLS policies and the permissions of the role `automations_watcher`.

## Run

Set `TEST_DATABASE_URL` to a superuser connection string of an empty test database. The `psql` program must be in the `PATH`. Then run `npm test`.

Without `TEST_DATABASE_URL`, the tests are skipped. The tests never use a real Supabase project.
