import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { psql } from "./psql.js";

const url = process.env.TEST_DATABASE_URL;
const read = (name: string) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const family = "00000000-0000-0000-0000-000000000004";
const child = "00000000-0000-0000-0000-0000000000c4";

function insertActivity(db: string, weekday: number): boolean {
  return psql(db, `insert into activities (family_id, child_id, name, weekday, start_time, end_time) values ('${family}', '${child}', 'Chess', ${weekday}, '15:00', '16:00')`).ok;
}

describe("0004_weekday_1_to_7.sql file", () => {
  it("checks weekday 1 to 7", () => {
    expect(read("0004_weekday_1_to_7.sql")).toContain("check (weekday between 1 and 7)");
  });
});

describe.skipIf(!url)("0004_weekday_1_to_7.sql", () => {
  const db = url ?? "";

  beforeAll(() => {
    expect(psql(db, read("0001_init.sql")).ok).toBe(true);
    const seed = [
      `delete from families where id = '${family}'`,
      `insert into families (id, name) values ('${family}', 'Example Family')`,
      `insert into children (id, family_id, name) values ('${child}', '${family}', 'Child One')`,
      `insert into activities (family_id, child_id, name, weekday, start_time, end_time) values ('${family}', '${child}', 'Old Sunday', 0, '10:00', '11:00'), ('${family}', '${child}', 'Old Monday', 1, '10:00', '11:00')`,
    ].join("; ");
    expect(psql(db, seed).ok).toBe(true);
    expect(psql(db, read("0004_weekday_1_to_7.sql")).ok).toBe(true);
    expect(psql(db, read("0004_weekday_1_to_7.sql")).ok).toBe(true);
  });

  it("stores Sunday as 7 and rejects 0 and 8", () => {
    expect(insertActivity(db, 7)).toBe(true);
    expect(insertActivity(db, 1)).toBe(true);
    expect(insertActivity(db, 0)).toBe(false);
    expect(insertActivity(db, 8)).toBe(false);
  });

  it("moves an old weekday 0 row to 7 and keeps 1 to 6", () => {
    const out = psql(db, `select name || ':' || weekday from activities where family_id = '${family}' and name like 'Old %' order by name`).output;
    expect(out).toContain("Old Sunday:7");
    expect(out).toContain("Old Monday:1");
  });
});
