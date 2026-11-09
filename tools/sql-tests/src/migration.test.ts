import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { asWatcher, psql } from "./psql.js";

const url = process.env.TEST_DATABASE_URL;
const migration = readFileSync(new URL("../../../supabase/migrations/0001_init.sql", import.meta.url), "utf8");
const family = "00000000-0000-0000-0000-000000000001";

function count(db: string, sql: string): number {
  const lines = asWatcher(db, sql).output.split("\n");
  return Number(lines.find((line) => /^\d+$/.test(line)));
}

describe.skipIf(!url)("0001_init.sql", () => {
  const db = url ?? "";

  beforeAll(() => {
    expect(psql(db, migration).ok).toBe(true);
    expect(psql(db, migration).ok).toBe(true);
    const seed = [
      `delete from outbox where family_id = '${family}'; delete from items where family_id = '${family}'; delete from families where id = '${family}'`,
      `insert into families (id, name) values ('${family}', 'Example Family')`,
      `insert into children (family_id, name) values ('${family}', 'Child One')`,
      `insert into outbox (key, family_id, chat_id, text, delivered_at) values
        ('old', '${family}', '1000001', 'old', now() - interval '31 days'),
        ('new', '${family}', '1000001', 'new', now() - interval '1 day'),
        ('pending', '${family}', '1000001', 'pending', null)`,
    ].join("; ");
    expect(psql(db, seed).ok).toBe(true);
  });

  it("lets the watcher read the config tables", () => {
    for (const table of ["families", "children", "accounts", "activities", "recipients"]) {
      expect(asWatcher(db, `select count(*) from ${table}`).ok).toBe(true);
    }
    expect(count(db, `select count(*) from children where family_id = '${family}'`)).toBe(1);
  });

  it("does not let the watcher write the config tables", () => {
    expect(asWatcher(db, `insert into children (family_id, name) values ('${family}', 'Child Two')`).ok).toBe(false);
    expect(asWatcher(db, `update children set name = 'Other'`).ok).toBe(false);
    expect(asWatcher(db, `delete from children`).ok).toBe(false);
    expect(asWatcher(db, `update families set name = 'Other'`).ok).toBe(false);
  });

  it("lets the watcher insert items but not change them", () => {
    expect(asWatcher(db, `insert into items (family_id, watcher, id) values ('${family}', 'librus', 'a')`).ok).toBe(true);
    expect(asWatcher(db, `update items set watcher = 'x'`).ok).toBe(false);
    expect(asWatcher(db, `delete from items`).ok).toBe(false);
  });

  it("lets the watcher insert outbox entries", () => {
    expect(asWatcher(db, `insert into outbox (key, family_id, chat_id, text) values ('k1', '${family}', '1000001', 't')`).ok).toBe(true);
  });

  it("lets the watcher update only delivered_at in the outbox", () => {
    expect(asWatcher(db, `update outbox set delivered_at = now() where key = 'pending'`).ok).toBe(true);
    const forbidden = {
      text: "'x'",
      chat_id: "'x'",
      key: "'x'",
      queued_at: "now()",
      family_id: `'${family}'`,
    };
    for (const [column, value] of Object.entries(forbidden)) {
      expect(asWatcher(db, `update outbox set ${column} = ${value}`).ok).toBe(false);
    }
  });

  it("lets the watcher delete only outbox entries delivered more than 30 days ago", () => {
    expect(count(db, "with d as (delete from outbox returning key) select count(*) from d")).toBe(1);
    expect(count(db, "with d as (delete from outbox where key = 'new' returning key) select count(*) from d")).toBe(0);
  });
});
