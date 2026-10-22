import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { asWatcher, psql } from "./psql.js";

const url = process.env.TEST_DATABASE_URL;
const read = (name: string) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), "utf8");
const family = "00000000-0000-0000-0000-000000000002";
const sealed = "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==";

describe.skipIf(!url)("0002_credentials.sql", () => {
  const db = url ?? "";

  beforeAll(() => {
    expect(psql(db, read("0001_init.sql")).ok).toBe(true);
    expect(psql(db, read("0002_credentials.sql")).ok).toBe(true);
    expect(psql(db, read("0002_credentials.sql")).ok).toBe(true);
    const seed = [
      `delete from credentials where family_id = '${family}'`,
      `insert into families (id, name) values ('${family}', 'Example Family Two') on conflict do nothing`,
      `insert into credentials (family_id, name, ciphertext) values ('${family}', 'CHILD1_LIBRUS_LOGIN', '${sealed}')`,
    ].join("; ");
    expect(psql(db, seed).ok).toBe(true);
  });

  it("lets the watcher read the ciphertext", () => {
    const result = asWatcher(db, `select ciphertext from credentials where family_id = '${family}'`);
    expect(result.ok).toBe(true);
    expect(result.output).toContain(sealed);
  });

  it("does not let the watcher write credentials", () => {
    expect(asWatcher(db, `insert into credentials (family_id, name, ciphertext) values ('${family}', 'X', '${sealed}')`).ok).toBe(false);
    expect(asWatcher(db, `update credentials set ciphertext = '${sealed}'`).ok).toBe(false);
    expect(asWatcher(db, `delete from credentials`).ok).toBe(false);
  });

  it("rejects plaintext and bad names", () => {
    expect(psql(db, `insert into credentials (family_id, name, ciphertext) values ('${family}', 'P', 'hunter2')`).ok).toBe(false);
    expect(psql(db, `insert into credentials (family_id, name, ciphertext) values ('${family}', 'bad name', '${sealed}')`).ok).toBe(false);
  });
});
