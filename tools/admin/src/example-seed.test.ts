import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkSeedRow } from "./commands.ts";
import type { Row } from "./rest.ts";

const seed = JSON.parse(
  readFileSync(new URL("../../../examples/seed.example.json", import.meta.url), "utf8"),
) as Record<string, Row[]>;

describe("examples/seed.example.json", () => {
  it("has only the five seed tables", () => {
    expect(Object.keys(seed).sort()).toEqual(["accounts", "activities", "children", "families", "recipients"]);
  });

  it("accepts every Account row with secret names", () => {
    for (const row of seed.accounts) expect(() => checkSeedRow("accounts", row)).not.toThrow();
  });

  it("links each row to rows that exist", () => {
    const ids = new Set(Object.values(seed).flatMap((rows) => rows.map((row) => row.id)));
    for (const row of [...seed.children, ...seed.accounts, ...seed.activities, ...seed.recipients]) {
      expect(ids.has(row.family_id)).toBe(true);
    }
    for (const row of [...seed.accounts, ...seed.activities]) expect(ids.has(row.child_id)).toBe(true);
    for (const row of seed.activities) expect(ids.has(row.account_id)).toBe(true);
    for (const row of seed.recipients) for (const id of row.child_ids as string[]) expect(ids.has(id)).toBe(true);
  });

  it("has Recipients in pl and en", () => {
    expect(seed.recipients.map((row) => row.language).sort()).toEqual(["en", "pl"]);
  });
});
