import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { asWatcher, psql } from "./psql.js";

const read = (name: string) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const sql = read("0017_librus_attachments_bucket.sql");
const url = process.env.TEST_DATABASE_URL;
const verifyScript = fileURLToPath(new URL("../../migrate/verify-storage.sh", import.meta.url));
const verify = (db: string) => {
  const run = spawnSync("bash", [verifyScript], { encoding: "utf8", env: { ...process.env, SUPABASE_DB_URL: db } });
  return { status: run.status, output: `${run.stdout}${run.stderr}`.trim() };
};

// Test-only stand-ins for the Supabase platform schema `storage` and the role `anon`. The migration never creates them.
const STORAGE_STAND_IN = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  end $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
  create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets (id), name text not null);
  alter table storage.objects enable row level security;
  insert into storage.buckets (id, name, public) values ('other-bucket', 'other-bucket', false);
`;

describe("0017_librus_attachments_bucket.sql file", () => {
  it("never creates or replaces a platform object and grants no update or delete", () => {
    expect(sql).not.toMatch(/create\s+(or\s+replace\s+)?(function|table|schema)/i);
    expect(sql).not.toMatch(/auth\./i);
    expect(sql).not.toMatch(/revoke/i);
    expect(sql).not.toMatch(/grant[^;']*\b(update|delete)\b/i);
    expect(sql).not.toContain("family_id'");
    expect(sql).toContain("on conflict (id) do update set public = false");
  });
});

describe.skipIf(!url)("0017_librus_attachments_bucket.sql", () => {
  const db = url ?? "";
  const asAnon = (query: string) => psql(db, `begin; set local role anon; ${query}; rollback`);

  beforeAll(() => {
    expect(psql(db, read("0001_init.sql")).ok).toBe(true);
  });

  it("does nothing without a storage schema (plain Postgres)", () => {
    expect(psql(db, sql).ok).toBe(true);
    expect(psql(db, "select count(*) from pg_namespace where nspname = 'storage'").output).toBe("0");
    expect(verify(db)).toEqual({ status: 0, output: "storage schema: missing (0017 did nothing)" });
  });

  describe("with the storage stand-in", () => {
    beforeAll(() => {
      expect(psql(db, STORAGE_STAND_IN).ok).toBe(true);
      expect(psql(db, sql).ok).toBe(true);
      expect(psql(db, sql).ok).toBe(true);
    });

    it("makes one private bucket", () => {
      expect(psql(db, "select public from storage.buckets where id = 'librus-attachments'").output).toBe("f");
    });

    it("lets the watcher add and read objects in the whole bucket", () => {
      const added = asWatcher(db, "insert into storage.objects (bucket_id, name) values ('librus-attachments', 'any-family/m1/a1') returning name");
      expect(added.ok).toBe(true);
      const read = asWatcher(db, "insert into storage.objects (bucket_id, name) values ('librus-attachments', 'f/m/a'); select count(*) from storage.objects");
      expect(read.ok).toBe(true);
      expect(read.output).toMatch(/^\s*1\s*$/m);
    });

    it("keeps the watcher out of other buckets", () => {
      expect(asWatcher(db, "insert into storage.objects (bucket_id, name) values ('other-bucket', 'x')").ok).toBe(false);
    });

    it("gives the watcher no update and no delete", () => {
      expect(asWatcher(db, "update storage.objects set name = 'y'").ok).toBe(false);
      expect(asWatcher(db, "delete from storage.objects").ok).toBe(false);
    });

    it("gives anon no access", () => {
      expect(asAnon("select count(*) from storage.objects").ok).toBe(false);
      expect(asAnon("insert into storage.objects (bucket_id, name) values ('librus-attachments', 'x')").ok).toBe(false);
    });

    it("verify-storage.sh prints only the bucket, its flag and the policies, and fails on a public bucket", () => {
      expect(verify(db)).toEqual({
        status: 0,
        output: [
          "bucket: librus-attachments public=false",
          "policies:",
          "watcher_attachment_insert INSERT automations_watcher",
          "watcher_attachment_read SELECT automations_watcher",
          "result: OK (private bucket, watcher select and insert only)",
        ].join("\n"),
      });
      expect(psql(db, "update storage.buckets set public = true where id = 'librus-attachments'").ok).toBe(true);
      try {
        const publicBucket = verify(db);
        expect(publicBucket.status).toBe(1);
        expect(publicBucket.output).toContain("result: NOT OK");
      } finally {
        expect(psql(db, "update storage.buckets set public = false where id = 'librus-attachments'").ok).toBe(true);
      }
    });
  });
});
