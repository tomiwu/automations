import type { PsqlResult } from "./psql.js";

export type RunSql = (url: string, sql: string) => PsqlResult;

export function databaseUrl(base: string, name: string): string {
  const url = new URL(base);
  url.pathname = `/${name}`;
  return url.toString();
}

export function newDatabaseName(random: () => number = Math.random): string {
  return `sql_test_${Math.floor(random() * 1e12).toString(36)}`;
}

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
