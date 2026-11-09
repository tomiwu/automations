import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { psql } from "./psql.js";

const read = (name: string) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const sql = read("0008_journal_backfill.sql");
const url = process.env.TEST_DATABASE_URL;
const family = "00000000-0000-0000-0000-000000000008";
const child = "00000000-0000-0000-0000-0000000000c8";

describe("0008_journal_backfill.sql file", () => {
  it("defines the function, hides it from public and never deletes", () => {
    expect(sql).toContain("create or replace function journal_backfill_items()");
    expect(sql).toContain("revoke all on function journal_backfill_items() from public");
    expect(sql).toContain("select journal_backfill_items();");
    expect(sql).not.toMatch(/delete\s+from|truncate|drop\s+table/i);
  });
});

describe.skipIf(!url)("0008_journal_backfill.sql", () => {
  const db = url ?? "";
  const insert = (id: string, hash: string, seen: string) =>
    `insert into item_details (family_id, scope, kind, child_id, source_id, content_hash, date, start_time, title, text, source_updated_at, first_seen) values ('${family}', 'messages:c1', 'message', '${child}', '${id}', '${hash}', '2026-01-05', '08:30', 'Title ${hash}', 'Text', '2026-01-05 07:00:00+00', '${seen}')`;
  const one = (query: string) => psql(db, query).output;
  const events = () =>
    one(`select stream || '|' || seq || '|' || event_type || '|' || recorded_at at time zone 'UTC' from journal_events where family_id = '${family}' order by stream, seq`);

  beforeAll(() => {
    expect(psql(db, read("0001_init.sql")).ok).toBe(true);
    expect(psql(db, read("0006_item_details.sql")).ok).toBe(true);
    expect(psql(db, read("0007_journal_events.sql")).ok).toBe(true);
    const seed = [
      `alter table journal_events disable trigger journal_events_no_change`,
      `alter table journal_events disable trigger journal_events_no_truncate`,
      `delete from journal_events where family_id = '${family}'`,
      `alter table journal_events enable trigger journal_events_no_change`,
      `alter table journal_events enable trigger journal_events_no_truncate`,
      `delete from families where id = '${family}'`,
      `insert into families (id, name) values ('${family}', 'Example Family')`,
      insert("m1", "hb", "2026-01-06 10:00:00+00"),
      insert("m1", "ha", "2026-01-05 10:00:00+00"),
      insert("m2", "hc", "2026-01-07 10:00:00+00"),
    ].join("; ");
    expect(psql(db, seed).ok).toBe(true);
  });

  it("runs two times without error", () => {
    expect(psql(db, sql).ok).toBe(true);
    expect(psql(db, sql).ok).toBe(true);
  });

  it("writes one event for each row with the right seq and time", () => {
    expect(events().split("\n")).toEqual([
      "item:messages:c1:m1|1|ItemRecorded|2026-01-05 10:00:00",
      "item:messages:c1:m1|2|ItemChanged|2026-01-06 10:00:00",
      "item:messages:c1:m2|1|ItemRecorded|2026-01-07 10:00:00",
    ]);
  });

  it("writes the payload keys and the backfill source", () => {
    const payload = one(`select payload::text from journal_events where family_id = '${family}' and stream = 'item:messages:c1:m2'`);
    expect(JSON.parse(payload)).toEqual({
      scope: "messages:c1",
      sourceId: "m2",
      kind: "message",
      childId: child,
      date: "2026-01-05",
      startTime: "08:30",
      endTime: null,
      title: "Title hc",
      text: "Text",
      sender: null,
      subject: null,
      category: null,
      sourceUpdatedAt: "2026-01-05T07:00:00.000Z",
    });
    expect(one(`select distinct source from journal_events where family_id = '${family}'`)).toBe("backfill-0008");
  });

  it("adds no row on a second run", () => {
    expect(one("select journal_backfill_items()")).toBe("0");
  });

  it("gives the next seq to a new row and keeps item_details unchanged", () => {
    expect(psql(db, insert("m2", "hd", "2026-01-08 10:00:00+00")).ok).toBe(true);
    expect(one("select journal_backfill_items()")).toBe("1");
    expect(events()).toContain("item:messages:c1:m2|2|ItemChanged|2026-01-08 10:00:00");
    expect(one(`select count(*) from item_details where family_id = '${family}'`)).toBe("4");
  });
});
