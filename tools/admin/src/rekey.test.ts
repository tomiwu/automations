import { decryptCredential, encryptCredential, importCredentialKey, newCredentialKey } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { configureSnippet, snippetFromEnv } from "./configure-snippet.ts";
import { cleanValue, credentialNames, LIBRUS_ORIGIN, rekey, type RekeyDeps } from "./rekey.ts";
import type { RestClient, Row } from "./rest.ts";

const FAMILY = "family-1";

function fake(store: Record<string, Row[]>, env: Record<string, string>, typed = "") {
  const out: string[] = [];
  const updates: string[] = [];
  const rest: RestClient = {
    insert: async () => [],
    select: async (table) => store[table] ?? [],
    update: async (table, query, patch) => {
      updates.push(`${table} ${query} ${JSON.stringify(patch)}`);
      return [patch];
    },
    upsert: async (table, rows) => {
      const kept = (store[table] ?? []).filter((old) => !rows.some((row) => row.name === old.name));
      store[table] = [...kept, ...rows];
      return [...rows];
    },
  };
  const deps: RekeyDeps = { rest, env, now: () => 0, print: (line) => out.push(line), readSecret: async () => typed };
  return { deps, out, updates };
}

describe("cleanValue", () => {
  it("removes a trailing CR or LF and trims a login only", () => {
    expect(cleanValue("A_EMAIL", " kid@example.com\r\n")).toBe("kid@example.com");
    expect(cleanValue("A_PASSWORD", " pass \r")).toBe(" pass ");
    expect(cleanValue("A_PASSWORD", undefined)).toBe("");
  });
});

describe("credentialNames", () => {
  it("joins account secret names and stored names", () => {
    expect(credentialNames([{ login_secret: "B_EMAIL", password_secret: "B_PASSWORD" }, { login_secret: null }], [{ name: "A_SECRET" }])).toEqual([
      "A_SECRET",
      "B_EMAIL",
      "B_PASSWORD",
    ]);
  });
});

describe("rekey", () => {
  it("encrypts from env, old rows and the prompt, sets the Librus origin and verifies", async () => {
    const oldKeyText = newCredentialKey();
    const newKeyText = newCredentialKey();
    const oldKey = await importCredentialKey(oldKeyText);
    const store: Record<string, Row[]> = {
      accounts: [{ service: "librus", login_secret: "L_USER", password_secret: "L_PASSWORD" }],
      credentials: [
        { name: "OLD_SECRET", ciphertext: await encryptCredential(oldKey, FAMILY, "OLD_SECRET", "kept") },
        { name: "L_PASSWORD", ciphertext: "v1.broken.row" },
      ],
    };
    const { deps, out, updates } = fake(store, { CREDENTIAL_KEY: oldKeyText, NEW_CREDENTIAL_KEY: newKeyText, L_USER: "kid@example.com\r" }, "typed");
    expect(await rekey(deps, FAMILY)).toBe(0);
    const newKey = await importCredentialKey(newKeyText);
    const value = async (name: string) => decryptCredential(newKey, FAMILY, name, String(store.credentials?.find((r) => r.name === name)?.ciphertext));
    expect(await value("L_USER")).toBe("kid@example.com");
    expect(await value("L_PASSWORD")).toBe("typed");
    expect(await value("OLD_SECRET")).toBe("kept");
    expect(out).toContain("L_USER: ok");
    expect(out.join("\n")).not.toMatch(/kid@example|typed|kept/);
    expect(updates[0]).toContain(LIBRUS_ORIGIN);
  });

  it("reports missing and undecryptable names", async () => {
    const store: Record<string, Row[]> = {
      accounts: [{ service: "mondo", login_secret: "M_EMAIL", password_secret: "M_PASSWORD" }],
      credentials: [{ name: "M_PASSWORD", ciphertext: "v1.AAAA.AAAA" }],
    };
    const { deps, out } = fake(store, { NEW_CREDENTIAL_KEY: newCredentialKey(), M_EMAIL: "kid@example.com" });
    expect(await rekey(deps, FAMILY)).toBe(1);
    expect(out).toContain("M_EMAIL: ok");
    expect(out).toContain("M_PASSWORD: does not decrypt");
  });

  it("stores nothing when no value is found", async () => {
    const { deps } = fake({ accounts: [{ login_secret: "X_EMAIL" }] }, { NEW_CREDENTIAL_KEY: newCredentialKey(), CREDENTIAL_KEY: "bad" });
    await expect(rekey(deps, FAMILY)).rejects.toThrow("nothing was stored");
  });
});

describe("configureSnippet", () => {
  const input = { supabaseUrl: "https://x.supabase.co", familyId: FAMILY, credentialKey: "K", allowlist: '["1",2]', adminToken: "t", withPayments: false };
  it("configures each package with the same key", () => {
    const code = configureSnippet(input);
    expect(code).toContain('import kradziejka from "kody:@tomiwu/kradziejka/configure";');
    expect(code).toContain('allowlist: ["1","2"]');
    expect(code).not.toContain("payments-watch");
    expect(configureSnippet({ ...input, withPayments: true })).toContain('["payments-watch", () => payments(base)]');
  });
  it("reads the input from the environment", () => {
    expect(snippetFromEnv({ WITH_PAYMENTS: "1", FAMILY_ID: FAMILY })).toContain("payments-watch");
    expect(snippetFromEnv({})).toContain("allowlist: []");
  });
  it("refuses an allowlist that is not a list", () => {
    expect(() => configureSnippet({ ...input, allowlist: "{}" })).toThrow("JSON list");
  });
});
