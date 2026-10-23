import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { asWatcher, psql } from "./psql.js";

const read = (name: string) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const sql = read("0005_payments.sql");
const url = process.env.TEST_DATABASE_URL;
const family = "00000000-0000-0000-0000-000000000005";
const child = "00000000-0000-0000-0000-0000000000c5";
const fee = "00000000-0000-0000-0000-0000000000f5";
const nrb = "12345678901234567890123456";

describe("0005_payments.sql file", () => {
  it("creates both tables with the grants and the checks", () => {
    expect(sql).toContain("create table if not exists fees");
    expect(sql).toContain("create table if not exists payments");
    expect(sql).toContain("grant select on fees to automations_watcher");
    expect(sql).toContain("grant select, insert, update on payments to automations_watcher");
    expect(sql).not.toMatch(/grant delete/i);
    expect(sql).toContain("check (notify_day < due_day)");
    expect(sql).toContain("unique (fee_id, month)");
  });
});

describe.skipIf(!url)("0005_payments.sql", () => {
  const db = url ?? "";

  const insertFee = (id: string, over: Record<string, string> = {}) => {
    const v = { nip: "'1234567890'", account: `'${nrb}'`, due_day: "15", notify_day: "10", ...over };
    return `insert into fees (id, family_id, child_id, organizer, recipient_name, nip, account, title, due_day, notify_day) values ('${id}', '${family}', '${child}', 'Example Club', 'Example Club', ${v.nip}, ${v.account}, 'Fee', ${v.due_day}, ${v.notify_day})`;
  };
  const insertPayment = (month: string, over: Record<string, string> = {}) => {
    const v = { amount: "10000", source: "config", status: "pending", ...over };
    return `insert into payments (family_id, fee_id, month, amount, amount_source, status) values ('${family}', '${fee}', '${month}', ${v.amount}, '${v.source}', '${v.status}')`;
  };

  beforeAll(() => {
    expect(psql(db, read("0001_init.sql")).ok).toBe(true);
    expect(psql(db, sql).ok).toBe(true);
    expect(psql(db, sql).ok).toBe(true);
    const seed = [
      `delete from families where id = '${family}'`,
      `insert into families (id, name) values ('${family}', 'Example Family')`,
      `insert into children (id, family_id, name) values ('${child}', '${family}', 'Child One')`,
      insertFee(fee),
    ].join("; ");
    expect(psql(db, seed).ok).toBe(true);
  });

  it("accepts a NIP of 10 digits or null", () => {
    expect(psql(db, `${insertFee("00000000-0000-0000-0000-0000000000f6", { nip: "null" })}`).ok).toBe(true);
  });

  it("rejects a bad NRB", () => {
    expect(psql(db, insertFee("00000000-0000-0000-0000-0000000000f7", { account: "'1234'" })).ok).toBe(false);
    expect(psql(db, insertFee("00000000-0000-0000-0000-0000000000f7", { account: `'PL${nrb.slice(2)}'` })).ok).toBe(false);
  });

  it("rejects a bad NIP", () => {
    expect(psql(db, insertFee("00000000-0000-0000-0000-0000000000f8", { nip: "'123'" })).ok).toBe(false);
  });

  it("rejects due and notify days out of 1-28", () => {
    expect(psql(db, insertFee("00000000-0000-0000-0000-0000000000f9", { due_day: "29" })).ok).toBe(false);
    expect(psql(db, insertFee("00000000-0000-0000-0000-0000000000f9", { due_day: "0", notify_day: "0" })).ok).toBe(false);
    expect(psql(db, insertFee("00000000-0000-0000-0000-0000000000f9", { due_day: "28", notify_day: "29" })).ok).toBe(false);
  });

  it("requires notify_day to be less than due_day", () => {
    expect(psql(db, insertFee("00000000-0000-0000-0000-0000000000fa", { due_day: "10", notify_day: "10" })).ok).toBe(false);
    expect(psql(db, insertFee("00000000-0000-0000-0000-0000000000fa", { due_day: "5", notify_day: "10" })).ok).toBe(false);
  });

  it("rejects a status that is not pending, paid or skipped", () => {
    expect(psql(db, insertPayment("2026-01", { status: "late" })).ok).toBe(false);
    expect(psql(db, insertPayment("2026-01", { status: "paid" })).ok).toBe(true);
    expect(psql(db, insertPayment("2026-02", { status: "skipped" })).ok).toBe(true);
  });

  it("rejects a bad month, source and amount", () => {
    expect(psql(db, insertPayment("2026-13")).ok).toBe(false);
    expect(psql(db, insertPayment("2026-03", { source: "guess" })).ok).toBe(false);
    expect(psql(db, insertPayment("2026-03", { amount: "0" })).ok).toBe(false);
  });

  it("keeps (fee_id, month) unique", () => {
    expect(psql(db, insertPayment("2026-04")).ok).toBe(true);
    expect(psql(db, insertPayment("2026-04")).ok).toBe(false);
  });

  it("lets the watcher read fees but not change them", () => {
    expect(asWatcher(db, `select organizer from fees where id = '${fee}'`).output).toContain("Example Club");
    expect(asWatcher(db, insertFee("00000000-0000-0000-0000-0000000000fb")).ok).toBe(false);
    expect(asWatcher(db, `update fees set title = 'Other' where id = '${fee}'`).ok).toBe(false);
    expect(asWatcher(db, `delete from fees where id = '${fee}'`).ok).toBe(false);
  });

  it("lets the watcher read, insert and update payments, and not delete them", () => {
    expect(asWatcher(db, insertPayment("2026-05")).ok).toBe(true);
    expect(asWatcher(db, `update payments set status = 'paid' where fee_id = '${fee}' and month = '2026-04'`).ok).toBe(true);
    expect(asWatcher(db, `select status from payments where fee_id = '${fee}' and month = '2026-04'`).output).toContain("pending");
    expect(asWatcher(db, `delete from payments where fee_id = '${fee}'`).ok).toBe(false);
  });
});
