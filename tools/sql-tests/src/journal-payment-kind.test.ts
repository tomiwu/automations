import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { asWatcher, psql } from "./psql.js";

const read = (name: string) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const sql = read("0011_journal_payment_kind.sql");
const url = process.env.TEST_DATABASE_URL;
const family = "00000000-0000-0000-0000-000000000011";
const child = "00000000-0000-0000-0000-0000000000c1";

describe("0011_journal_payment_kind.sql file", () => {
  it("replaces the kind constraint, allows payment and does not change rows", () => {
    expect(sql).toContain("drop constraint if exists journal_events_kind_check");
    expect(sql).toContain("'payment'");
    expect(sql).not.toMatch(/^\s*(update|delete|truncate|insert)\b/im);
  });
});

describe.skipIf(!url)("0011_journal_payment_kind.sql", () => {
  const db = url ?? "";
  const insert = (kind: string, stream: string) =>
    `insert into journal_events (family_id, child_id, stream, seq, kind, day, event_type, payload, content_hash, source) values ('${family}', '${child}', '${stream}', 1, '${kind}', null, 'PaymentCreated', '{}', 'h1', 'test')`;

  beforeAll(() => {
    expect(psql(db, read("0001_init.sql")).ok).toBe(true);
    expect(psql(db, read("0007_journal_events.sql")).ok).toBe(true);
    expect(psql(db, sql).ok).toBe(true);
    expect(psql(db, sql).ok).toBe(true);
    expect(psql(db, `insert into families (id, name) values ('${family}', 'Example Family') on conflict do nothing`).ok).toBe(true);
  });

  it("accepts kind payment once and rejects an unknown kind", () => {
    expect(asWatcher(db, insert("payment", "payment:fee1:2026-01")).ok).toBe(true);
    expect(psql(db, insert("unknown", "payment:fee2:2026-01")).ok).toBe(false);
  });

  it("still rejects update and delete of a payment row", () => {
    expect(psql(db, insert("payment", "payment:fee3:2026-01")).ok).toBe(true);
    expect(psql(db, "update journal_events set source = 'x' where kind = 'payment'").output).toContain("append-only");
    expect(psql(db, "delete from journal_events where kind = 'payment'").output).toContain("append-only");
  });
});
