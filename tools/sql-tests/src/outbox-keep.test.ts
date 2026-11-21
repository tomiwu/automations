import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asWatcher, psql } from "./psql.js";

const read = (name: string) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const sql = read("0010_outbox_keep.sql");
const url = process.env.TEST_DATABASE_URL;
const family = "00000000-0000-0000-0000-000000000010";

describe("0010_outbox_keep.sql file", () => {
  it("drops the purge policy and the delete grant", () => {
    expect(sql).toContain("drop policy if exists watcher_purge on outbox");
    expect(sql).toContain("revoke delete on outbox from automations_watcher");
    expect(sql).not.toMatch(/^\s*grant\b/im);
  });
});

describe.skipIf(!url)("0010_outbox_keep.sql", () => {
  const db = url ?? "";

  beforeAll(() => {
    expect(psql(db, read("0001_init.sql")).ok).toBe(true);
    expect(psql(db, sql).ok).toBe(true);
    expect(psql(db, sql).ok).toBe(true);
    const seed = [
      `delete from outbox where family_id = '${family}'; delete from families where id = '${family}'`,
      `insert into families (id, name) values ('${family}', 'Example Family')`,
      `insert into outbox (key, family_id, chat_id, text, delivered_at) values
        ('keep-old', '${family}', '1000001', 'old', now() - interval '400 days'),
        ('keep-pending', '${family}', '1000001', 'pending', null)`,
    ].join("; ");
    expect(psql(db, seed).ok).toBe(true);
  });

  // Other SQL tests count the delivered Outbox rows. Remove the rows of this test.
  afterAll(() => {
    expect(psql(db, `delete from outbox where family_id = '${family}'; delete from families where id = '${family}'`).ok).toBe(true);
  });

  it("does not let the watcher delete Outbox rows, also old delivered ones", () => {
    expect(asWatcher(db, `delete from outbox where key = 'keep-old'`).ok).toBe(false);
    expect(asWatcher(db, `delete from outbox`).ok).toBe(false);
  });

  it("still lets the watcher insert entries and mark them delivered", () => {
    expect(asWatcher(db, `insert into outbox (key, family_id, chat_id, text) values ('keep-new', '${family}', '1000001', 't')`).ok).toBe(true);
    expect(asWatcher(db, `update outbox set delivered_at = now() where key = 'keep-pending'`).ok).toBe(true);
  });
});
