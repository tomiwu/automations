import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { asWatcher, psql } from "./psql.js";

const read = (name: string) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const sql = read("0006_item_details.sql");
const url = process.env.TEST_DATABASE_URL;
const family = "00000000-0000-0000-0000-000000000006";
const child = "00000000-0000-0000-0000-0000000000c6";

describe("0006_item_details.sql file", () => {
  it("has RLS, a select and insert grant, and no update or delete grant", () => {
    expect(sql).toContain("create table if not exists item_details");
    expect(sql).toContain("alter table item_details enable row level security");
    expect(sql).toContain("grant select, insert on item_details to automations_watcher");
    expect(sql).not.toMatch(/grant[^;]*\b(update|delete)\b/i);
    expect(sql).not.toMatch(/for (update|delete)/i);
  });
});

describe.skipIf(!url)("0006_item_details.sql", () => {
  const db = url ?? "";
  const insert = (id: string, over: Record<string, string> = {}) => {
    const v = { kind: "message", hash: "h1", ...over };
    return `insert into item_details (family_id, scope, kind, child_id, source_id, content_hash, title, text) values ('${family}', 'messages:c1', '${v.kind}', '${child}', '${id}', '${v.hash}', 'Title', 'Text')`;
  };

  beforeAll(() => {
    expect(psql(db, read("0001_init.sql")).ok).toBe(true);
    expect(psql(db, sql).ok).toBe(true);
    expect(psql(db, sql).ok).toBe(true);
    const seed = [
      `delete from families where id = '${family}'`,
      `insert into families (id, name) values ('${family}', 'Example Family')`,
      insert("seed"),
    ].join("; ");
    expect(psql(db, seed).ok).toBe(true);
  });

  it("lets the watcher read and insert rows", () => {
    expect(asWatcher(db, "select count(*) from item_details").ok).toBe(true);
    expect(asWatcher(db, insert("a")).ok).toBe(true);
  });

  it("does not let the watcher update or delete rows", () => {
    expect(asWatcher(db, "update item_details set title = 'x'").ok).toBe(false);
    expect(asWatcher(db, "delete from item_details").ok).toBe(false);
  });

  it("keeps the old row when the content changes", () => {
    expect(psql(db, insert("seed", { hash: "h2" })).ok).toBe(true);
    expect(psql(db, insert("seed")).ok).toBe(false);
  });

  it("rejects an unknown kind", () => {
    expect(psql(db, insert("b", { kind: "other" })).ok).toBe(false);
  });
});
