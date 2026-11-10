import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { asWatcher, psql } from "./psql.js";

const read = (name: string) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const sql = read("0014_payment_refund_check.sql");
const url = process.env.TEST_DATABASE_URL;
const family = "00000000-0000-0000-0000-000000000014";
const child = "00000000-0000-0000-0000-0000000000c4";
const fee = "00000000-0000-0000-0000-0000000000f4";

describe("0014_payment_refund_check.sql file", () => {
  it("only adds a nullable column and does not change rows", () => {
    expect(sql).toContain("add column if not exists refund_check_at timestamptz");
    expect(sql).not.toMatch(/not null/i);
    expect(sql).not.toMatch(/^\s*(update|delete|truncate|insert)\b/im);
  });
});

describe.skipIf(!url)("0014_payment_refund_check.sql", () => {
  const db = url ?? "";

  beforeAll(() => {
    for (const name of ["0001_init.sql", "0005_payments.sql", "0007_journal_events.sql", "0011_journal_payment_kind.sql", "0012_payment_cancelled.sql"]) {
      expect(psql(db, read(name)).ok).toBe(true);
    }
    expect(psql(db, sql).ok).toBe(true);
    expect(psql(db, sql).ok).toBe(true);
    const setup = [
      `insert into families (id, name) values ('${family}', 'Example Family') on conflict do nothing`,
      `insert into children (id, family_id, name) values ('${child}', '${family}', 'Child One') on conflict do nothing`,
      `insert into fees (id, family_id, child_id, organizer, recipient_name, nip, account, title, due_day, notify_day) values ('${fee}', '${family}', '${child}', 'Example Club', 'Example Club', '1234567890', '12345678901234567890123456', 'Fee', 15, 10) on conflict do nothing`,
      `delete from payments where fee_id = '${fee}'`,
      `insert into payments (family_id, fee_id, month, amount, amount_source, status) values ('${family}', '${fee}', '2025-02', 10000, 'config', 'paid')`,
    ];
    for (const statement of setup) expect(psql(db, statement).ok).toBe(true);
  });

  it("has a nullable refund_check_at column that is empty for an existing row", () => {
    const column = psql(db, `select is_nullable from information_schema.columns where table_name = 'payments' and column_name = 'refund_check_at'`);
    expect(column.output).toContain("YES");
    expect(psql(db, `select count(*) from payments where fee_id = '${fee}' and refund_check_at is null`).output).toContain("1");
  });

  it("lets the watcher set the flag without a status change", () => {
    expect(asWatcher(db, `update payments set refund_check_at = now() where fee_id = '${fee}'`).ok).toBe(true);
    expect(psql(db, `select status from payments where fee_id = '${fee}' and refund_check_at is not null`).output).toContain("paid");
  });

  it("keeps the Journal append-only", () => {
    expect(asWatcher(db, `delete from journal_events`).ok).toBe(false);
    expect(asWatcher(db, `update journal_events set source = 'x'`).ok).toBe(false);
  });
});
