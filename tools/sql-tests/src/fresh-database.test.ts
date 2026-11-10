import { describe, expect, it } from "vitest";
import { databaseUrl, freshDatabase, newDatabaseName, type RunSql } from "./fresh-database.js";
import { psql } from "./psql.js";

const BASE = "postgresql://tester@127.0.0.1:5432/postgres";

function recorder(ok = true): { run: RunSql; calls: string[] } {
  const calls: string[] = [];
  return { calls, run: (url, sql) => (calls.push(`${url} | ${sql}`), { ok, output: ok ? "" : "permission denied" }) };
}

describe("fresh-database helpers", () => {
  it("replaces only the database name in the URL", () => {
    expect(databaseUrl(BASE, "sql_test_a1")).toBe("postgresql://tester@127.0.0.1:5432/sql_test_a1");
  });

  it("makes a safe, new name each time", () => {
    expect(newDatabaseName(() => 0.5)).toMatch(/^sql_test_[0-9a-z]+$/);
    expect(newDatabaseName(() => 0.1)).not.toBe(newDatabaseName(() => 0.2));
  });

  it("does nothing without TEST_DATABASE_URL", () => {
    const env: Record<string, string | undefined> = {};
    const { run, calls } = recorder();
    freshDatabase(env, run, "sql_test_x")();
    expect(calls).toEqual([]);
    expect(env.TEST_DATABASE_URL).toBeUndefined();
  });

  it("makes the database, points the URL to it, then drops it and sets the URL back", () => {
    const env: Record<string, string | undefined> = { TEST_DATABASE_URL: BASE };
    const { run, calls } = recorder();
    const drop = freshDatabase(env, run, "sql_test_x");
    expect(env.TEST_DATABASE_URL).toBe(databaseUrl(BASE, "sql_test_x"));
    drop();
    expect(env.TEST_DATABASE_URL).toBe(BASE);
    expect(calls).toEqual([`${BASE} | create database sql_test_x`, `${BASE} | drop database if exists sql_test_x with (force)`]);
  });

  it("stops at once when it cannot make the database", () => {
    const env: Record<string, string | undefined> = { TEST_DATABASE_URL: BASE };
    expect(() => freshDatabase(env, recorder(false).run, "sql_test_x")).toThrow("could not make the test database sql_test_x: permission denied");
    expect(env.TEST_DATABASE_URL).toBe(BASE);
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("each test file has its own database", () => {
  it("runs on a sql_test_ database that has no tables yet", () => {
    const db = process.env.TEST_DATABASE_URL ?? "";
    expect(psql(db, "select current_database()").output).toMatch(/^sql_test_[0-9a-z]+$/);
    expect(psql(db, "select count(*) from pg_tables where schemaname = 'public'").output).toBe("0");
  });
});
