import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { asWatcher, psql } from "./psql.js";

const read = (name: string) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const sql = read("0012_payment_cancelled.sql");
const url = process.env.TEST_DATABASE_URL;
const family = "00000000-0000-0000-0000-000000000012";
const child = "00000000-0000-0000-0000-0000000000c2";
const fee = "00000000-0000-0000-0000-0000000000f2";

describe("0012_payment_cancelled.sql file", () => {
  it("replaces the status check, allows cancelled and does not change rows", () => {
    expect(sql).toContain("drop constraint if exists payments_status_check");
    expect(sql).toContain("'cancelled'");
    expect(sql).not.toMatch(/^\s*(update|delete|truncate|insert)\b/im);
  });
});

describe.skipIf(!url)("0012_payment_cancelled.sql", () => {
  const db = url ?? "";
  const insertPayment = (month: string, status: string) =>
    `insert into payments (family_id, fee_id, month, amount, amount_source, status) values ('${family}', '${fee}', '${month}', 10000, 'config', '${status}')`;
  const insertEvent = (stream: string) =>
    `insert into journal_events (family_id, child_id, stream, seq, kind, day, event_type, payload, content_hash, source) values ('${family}', '${child}', '${stream}', 1, 'payment', null, 'PaymentCancelled', '{"status":"cancelled"}', 'h1', 'test')`;

  beforeAll(() => {
    for (const name of ["0001_init.sql", "0005_payments.sql", "0007_journal_events.sql", "0011_journal_payment_kind.sql"]) {
      expect(psql(db, read(name)).ok).toBe(true);
    }
    expect(psql(db, sql).ok).toBe(true);
    expect(psql(db, sql).ok).toBe(true);
    const setup = [
      `insert into families (id, name) values ('${family}', 'Example Family') on conflict do nothing`,
      `insert into children (id, family_id, name) values ('${child}', '${family}', 'Child One') on conflict do nothing`,
      `insert into fees (id, family_id, child_id, organizer, recipient_name, nip, account, title, due_day, notify_day) values ('${fee}', '${family}', '${child}', 'Example Club', 'Example Club', '1234567890', '12345678901234567890123456', 'Fee', 15, 10) on conflict do nothing`,
    ];
    for (const statement of setup) expect(psql(db, statement).ok).toBe(true);
  });

  it("accepts cancelled and still rejects an unknown status", () => {
    expect(psql(db, insertPayment("2026-01", "cancelled")).ok).toBe(true);
    expect(psql(db, insertPayment("2026-02", "late")).ok).toBe(false);
  });

  it("lets the watcher cancel a pending Payment", () => {
    expect(psql(db, insertPayment("2026-03", "pending")).ok).toBe(true);
    expect(asWatcher(db, `update payments set status = 'cancelled' where fee_id = '${fee}' and month = '2026-03'`).ok).toBe(true);
  });

  it("still rejects update and delete of journal rows", () => {
    expect(psql(db, insertEvent("payment:c2:f2:2026-03")).ok).toBe(true);
    expect(psql(db, `update journal_events set source = 'x' where family_id = '${family}'`).output).toContain("append-only");
    expect(psql(db, `delete from journal_events where family_id = '${family}'`).output).toContain("append-only");
  });
});
