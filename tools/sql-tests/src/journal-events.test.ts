import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { asWatcher, psql } from "./psql.js";

const read = (name: string) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const sql = read("0007_journal_events.sql");
const url = process.env.TEST_DATABASE_URL;
const family = "00000000-0000-0000-0000-000000000007";
const child = "00000000-0000-0000-0000-0000000000c7";

describe("0007_journal_events.sql file", () => {
  it("has the triggers, the invoker view, RLS and no update or delete grant", () => {
    expect(sql).toContain("create table if not exists journal_events");
    expect(sql).toContain("before update or delete on journal_events");
    expect(sql).toContain("before truncate on journal_events");
    expect(sql).toContain("journal_events is append-only");
    expect(sql).toContain("security_invoker = true");
    expect(sql).toContain("alter table journal_events enable row level security");
    expect(sql).toContain("grant select, insert on journal_events to automations_watcher");
    expect(sql).toContain("grant select on journal_heads to automations_watcher");
    expect(sql).not.toMatch(/grant[^;]*\b(update|delete)\b/i);
  });
});

describe.skipIf(!url)("0007_journal_events.sql", () => {
  const db = url ?? "";
  const insert = (stream: string, seq: number) =>
    `insert into journal_events (family_id, child_id, stream, seq, kind, day, event_type, payload, content_hash, source) values ('${family}', '${child}', '${stream}', ${seq}, 'lesson', '2026-01-05', 'added', '{}', 'h${seq}', 'test')`;

  beforeAll(() => {
    expect(psql(db, read("0001_init.sql")).ok).toBe(true);
    expect(psql(db, sql).ok).toBe(true);
    expect(psql(db, sql).ok).toBe(true);
    const seed = [
      `alter table journal_events disable trigger journal_events_no_change`,
      `alter table journal_events disable trigger journal_events_no_truncate`,
      `delete from journal_events where family_id = '${family}'`,
      `alter table journal_events enable trigger journal_events_no_change`,
      `alter table journal_events enable trigger journal_events_no_truncate`,
      `insert into families (id, name) values ('${family}', 'Example Family') on conflict do nothing`,
      insert("s1", 1),
      insert("s1", 2),
      insert("s2", 1),
    ].join("; ");
    expect(psql(db, seed).ok).toBe(true);
  });

  it("lets the watcher read and insert rows", () => {
    expect(asWatcher(db, "select count(*) from journal_events").ok).toBe(true);
    expect(asWatcher(db, insert("s3", 1)).ok).toBe(true);
  });

  it("rejects update, delete and truncate for the watcher and the owner", () => {
    for (const run of [(q: string) => asWatcher(db, q), (q: string) => psql(db, q)]) {
      expect(run("update journal_events set source = 'x'").ok).toBe(false);
      expect(run("delete from journal_events").ok).toBe(false);
      expect(run("truncate journal_events").ok).toBe(false);
    }
    expect(psql(db, "update journal_events set source = 'x'").output).toContain("append-only");
  });

  it("rejects a duplicate seq and seq 0", () => {
    expect(psql(db, insert("s1", 2)).ok).toBe(false);
    expect(psql(db, insert("s4", 0)).ok).toBe(false);
  });

  it("returns only the highest seq of each stream in journal_heads", () => {
    const result = asWatcher(db, `select stream || ':' || seq from journal_heads where family_id = '${family}' order by stream`);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("s1:2");
    expect(result.output).toContain("s2:1");
    expect(result.output).not.toContain("s1:1");
  });
});
