import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const script = new URL("../apply.sh", import.meta.url).pathname;

function apply(dbUrl: string, dir?: string): { ok: boolean; output: string } {
  const run = spawnSync(script, dir ? [dir] : [], {
    encoding: "utf8",
    env: { ...process.env, SUPABASE_DB_URL: dbUrl },
  });
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}` };
}

function query(dbUrl: string, sql: string): string {
  const run = spawnSync("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", dbUrl, "-c", sql], {
    encoding: "utf8",
  });
  return run.stdout.trim();
}

describe("apply.sh without a connection string", () => {
  it("prints a message and exits 0", () => {
    const result = apply("");
    expect(result.ok).toBe(true);
    expect(result.output).toContain("SUPABASE_DB_URL is empty");
  });
});

describe.skipIf(!url)("apply.sh against Postgres", () => {
  const db = url ?? "";

  it("applies the files once and skips them on the second run", () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-"));
    writeFileSync(join(dir, "0001_a.sql"), "create table if not exists migrate_probe_a (id int);");
    writeFileSync(join(dir, "0002_b.sql"), "create table migrate_probe_b (id int);");

    const first = apply(db, dir);
    expect(first.ok).toBe(true);
    expect(first.output).toContain("apply 0001_a.sql");
    expect(first.output).toContain("apply 0002_b.sql");
    expect(first.output).toContain("applied 2, skipped 0");

    const second = apply(db, dir);
    expect(second.ok).toBe(true);
    expect(second.output).not.toContain("apply 0");
    expect(second.output).toContain("applied 0, skipped 2");

    expect(query(db, "select count(*) from public.schema_migrations where name in ('0001_a.sql', '0002_b.sql')")).toBe("2");
    query(db, "drop table migrate_probe_a, migrate_probe_b; delete from public.schema_migrations where name in ('0001_a.sql', '0002_b.sql')");
  });

  it("stops and records nothing when a file fails", () => {
    const dir = mkdtempSync(join(tmpdir(), "migrate-"));
    writeFileSync(join(dir, "0009_bad.sql"), "select * from table_that_does_not_exist;");
    expect(apply(db, dir).ok).toBe(false);
    expect(query(db, "select count(*) from public.schema_migrations where name = '0009_bad.sql'")).toBe("0");
  });

  it("applies the real migrations twice and leaves the watcher without access", () => {
    expect(apply(db).ok).toBe(true);
    expect(apply(db).output).toMatch(/applied 0, skipped \d+/);
    expect(
      query(db, "select has_table_privilege('automations_watcher', 'public.schema_migrations', 'select')"),
    ).toBe("f");
  });
});
