import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { asWatcher, psql } from "./psql.js";

const read = (name: string) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const familyA = "00000000-0000-4000-8000-00000000a001";
const familyB = "00000000-0000-4000-8000-00000000a002";
const url = process.env.TEST_DATABASE_URL;

describe("0017_librus_attachments_bucket.sql file", () => {
  it("creates a private bucket and family-scoped policies", () => {
    const sql = read("0017_librus_attachments_bucket.sql");
    expect(sql).toContain("librus-attachments");
    expect(sql).toContain("watcher_attachment_read");
    expect(sql).toContain("auth.jwt() ->> 'family_id'");
  });
});

describe.skipIf(!url)("0017_librus_attachments_bucket.sql", () => {
  const db = url ?? "";

  beforeAll(() => {
    expect(psql(db, read("0001_init.sql")).ok).toBe(true);
    expect(psql(db, read("0017_librus_attachments_bucket.sql")).ok).toBe(true);
    expect(
      psql(
        db,
        [
          `insert into storage.buckets (id, name, public) values ('librus-attachments', 'librus-attachments', false) on conflict do nothing`,
          `insert into storage.objects (bucket_id, name) values ('librus-attachments', '${familyB}/m1/a1')`,
          `insert into storage.objects (bucket_id, name) values ('librus-attachments', '${familyA}/m1/a1')`,
        ].join("; "),
      ).ok,
    ).toBe(true);
  });

  it("lets the watcher read only its family prefix", () => {
    const withJwt = (family: string, sql: string) =>
      `begin; set local role automations_watcher; set local request.jwt.claim = '{"family_id":"${family}"}'; ${sql}; rollback`;
    expect(psql(db, withJwt(familyA, "select count(*) from storage.objects")).output).toContain("1");
    expect(psql(db, withJwt(familyA, "select count(*) from storage.objects where name like '${familyB}%'")).output).toContain("0");
  });

  it("gives anon no access", () => {
    expect(psql(db, "begin; set local role anon; select count(*) from storage.objects; rollback").ok).toBe(false);
  });
});