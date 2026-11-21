import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { asWatcher, psql } from "./psql.js";

const read = (name: string) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const sql = read("0017_librus_attachments_bucket.sql");
const url = process.env.TEST_DATABASE_URL;

// Test-only stand-ins for the Supabase platform schema `storage` and the role `anon`. The migration never creates them.
const STORAGE_STAND_IN = `
  do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  end $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
  create table storage.objects (id bigserial primary key, bucket_id text references storage.buckets (id), name text not null);
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
      expect(read.output.trim().split("\n").pop()).toBe("1");
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
  });
});
