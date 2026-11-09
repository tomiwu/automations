import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { asWatcher, psql } from "./psql.js";

const sql = readFileSync(new URL("../../../supabase/migrations/0003_kradziejka.sql", import.meta.url), "utf8");
const url = process.env.TEST_DATABASE_URL;
const read = (name: string) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const family = "00000000-0000-0000-0000-000000000003";
const sealed = "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==";
const webhook = "https://api2.cursor.sh/automations/webhook/example";

describe("0003_kradziejka.sql file", () => {
  it("creates the registry and does not grant delete", () => {
    expect(sql).toContain("create table if not exists kradziejka_bots");
    expect(sql).toContain("grant select, insert, update on kradziejka_bots to automations_watcher");
    expect(sql).not.toMatch(/grant delete/i);
    expect(sql).toContain("slug <> 'create_new_bot'");
    expect(sql).toContain("webhook_key_ciphertext");
  });
});

describe.skipIf(!url)("0003_kradziejka.sql", () => {
  const db = url ?? "";

  beforeAll(() => {
    expect(psql(db, read("0001_init.sql")).ok).toBe(true);
    expect(psql(db, read("0003_kradziejka.sql")).ok).toBe(true);
    expect(psql(db, read("0003_kradziejka.sql")).ok).toBe(true);
    const seed = [
      `delete from kradziejka_bots where family_id = '${family}'`,
      `insert into families (id, name) values ('${family}', 'Example Family') on conflict do nothing`,
    ].join("; ");
    expect(psql(db, seed).ok).toBe(true);
  });

  it("lets the watcher insert and update a bot, and not delete it", () => {
    const insert = `insert into kradziejka_bots (family_id, slug, name, description, webhook_url, webhook_key_ciphertext) values ('${family}', 'hub', 'Hub', 'Chooses an agent.', '${webhook}', '${sealed}')`;
    const update = `update kradziejka_bots set name = 'Hub bot' where family_id = '${family}'`;
    const read = `select name from kradziejka_bots where family_id = '${family}'`;
    const result = asWatcher(db, `${insert}; ${update}; ${read}`);
    expect(result.ok).toBe(true);
    expect(result.output).toContain("Hub bot");
    expect(asWatcher(db, `${insert}; delete from kradziejka_bots where family_id = '${family}'`).ok).toBe(false);
  });

  it("rejects plaintext keys, the reserved slug, and a non-Cursor URL", () => {
    expect(psql(db, `insert into kradziejka_bots (family_id, slug, name, description, webhook_url, webhook_key_ciphertext) values ('${family}', 'other', 'N', 'D', '${webhook}', 'plaintext')`).ok).toBe(false);
    expect(psql(db, `insert into kradziejka_bots (family_id, slug, name, description, webhook_url, webhook_key_ciphertext) values ('${family}', 'create_new_bot', 'N', 'D', '${webhook}', '${sealed}')`).ok).toBe(false);
    expect(psql(db, `insert into kradziejka_bots (family_id, slug, name, description, webhook_url, webhook_key_ciphertext) values ('${family}', 'other', 'N', 'D', 'https://example.test/hook', '${sealed}')`).ok).toBe(false);
  });
});
