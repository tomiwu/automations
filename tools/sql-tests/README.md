# sql-tests

Tests for `supabase/migrations/*.sql`. They apply the migration to a Postgres database and check the RLS policies and the permissions of the role `automations_watcher`.

## Run

Set `TEST_DATABASE_URL` to a superuser connection string of an empty test database. The `psql` program must be in the `PATH`. Then run `npm test`.

To run them on your computer without a database, run `npm run test:sql:local` at the root. It starts `postgres:17` with podman or docker on a free port, sets `TEST_DATABASE_URL`, runs these tests and removes the container (also on a failure). `SQL_TEST_ENGINE=docker` chooses the engine. Without `TEST_DATABASE_URL`, `npm test` skips the database tests and prints one line that names this command.

Each test file runs on its own new empty database (`sql_test_*`) on the server of `TEST_DATABASE_URL`, so the rows of one file cannot change the result of another file. The setup file `src/file-database.ts` makes the database before the file and drops it after the file. The role in `TEST_DATABASE_URL` must be able to make databases.

`asWatcher` runs the SQL as `automations_watcher` in one transaction and then rolls it back. To check the result of a watcher change, read it in the same `asWatcher` call.

Without `TEST_DATABASE_URL`, the tests are skipped. The tests never use a real Supabase project.
