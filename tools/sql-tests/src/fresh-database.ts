import type { PsqlResult } from "./psql.js";

/** Runs one SQL command on a database URL (the signature of `psql`). */
export type RunSql = (url: string, sql: string) => PsqlResult;

/** The URL `base` with the database name replaced by `name`. */
export function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

/** A new database name with only lowercase letters, digits and underscores. */
export function newDatabaseName(random: () => number = Math.random): string {
  return `sql_test_${Math.floor(random() * 1e12).toString(36)}`;
}

/**
 * Gives one test file its own empty database. When `env.TEST_DATABASE_URL` is set, it makes a new
 * database on that server and points `env.TEST_DATABASE_URL` to it. The returned function drops the
 * database and sets the URL back. Without `TEST_DATABASE_URL`, it does nothing.
 */
export function freshDatabase(env: Record<string, string | undefined>, run: RunSql, name = newDatabaseName()): () => void {
  const base = env.TEST_DATABASE_URL;
  if (!base) return () => undefined;
  const created = run(base, `create database ${name}`);
  if (!created.ok) throw new Error(`sql-tests: could not make the test database ${name}: ${created.output}`);
  env.TEST_DATABASE_URL = databaseUrl(base, name);
  return () => {
    run(base, `drop database if exists ${name} with (force)`);
    env.TEST_DATABASE_URL = base;
  };
}
