import { createHmac } from "node:crypto";
import { decryptCredential, importCredentialKey, newCredentialKey } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.ts";
import { runAdmin, type AdminDeps } from "./commands.ts";
import { signWatcherKey } from "./jwt.ts";
import { createRestClient, type RestClient, type Row } from "./rest.ts";

function setup(files: Record<string, string> = {}, env: Record<string, string> = {}, typed = "typed value") {
  const calls: string[] = [];
  const out: string[] = [];
  const store: Record<string, Row[]> = {};
  const rest: RestClient = {
    insert: async (table, rows) => {
      calls.push(`insert ${table}`);
      const made = rows.map((row, i) => ({ id: `${table}-${i + 1}`, ...row }));
      store[table] = [...(store[table] ?? []), ...made];
      return made;
    },
    select: async (table, query) => {
      calls.push(`select ${table} ${query}`);
      return store[table] ?? [];
    },
    update: async (table, query, patch) => {
      calls.push(`update ${table} ${query}`);
      return query === "id=eq.missing" ? [] : [{ ...patch }];
    },
    upsert: async (table, rows) => {
      calls.push(`upsert ${table}`);
      const keyOf = (row: Row) => `${String(row.family_id)}:${String(row.name)}`;
      const kept = (store[table] ?? []).filter((old) => !rows.some((row) => keyOf(row) === keyOf(old)));
      store[table] = [...kept, ...rows];
      return [...rows];
    },
  };
  const deps: AdminDeps = {
    rest: () => rest,
    env,
    readFile: async (path) => files[path] ?? "",
    now: () => 1_700_000_000_000,
    print: (line) => out.push(line),
    readSecret: async () => typed,
    readStdin: async () => `${typed}-from-stdin\n`,
  };
  return { deps, calls, out, store };
}

describe("parseArgs", () => {
  it("splits flags and positional values", () => {
    expect(parseArgs(["file.json", "--name", "A B", "--has-librus"])).toEqual({
      positional: ["file.json"],
      flags: { name: "A B", "has-librus": "true" },
    });
  });
});

describe("commands", () => {
  it("adds a family", async () => {
    const { deps, store, out } = setup();
    await runAdmin(["add-family", "--name", "Example Family", "--language", "pl"], deps);
    expect(store.families?.[0]).toMatchObject({ name: "Example Family", timezone: "UTC", default_language: "pl" });
    expect(out).toEqual(["Added to families: families-1"]);
  });

  it("rejects an unknown language", async () => {
    await expect(runAdmin(["add-family", "--name", "X", "--language", "de"], setup().deps)).rejects.toThrow("--language");
  });

  it("adds a child", async () => {
    const { deps, store } = setup();
    await runAdmin(["add-child", "--family", "f1", "--name", "Child One", "--has-librus", "--calendar-id", "cal1"], deps);
    expect(store.children?.[0]).toMatchObject({ family_id: "f1", name: "Child One", has_librus: true, calendar_id: "cal1" });
  });

  it("adds an account and prints the secret names", async () => {
    const { deps, store, out } = setup();
    await runAdmin(
      ["add-account", "--family", "f1", "--child", "c1", "--service", "mondo", "--login-secret", "CHILD1_MONDO_LOGIN", "--password-secret", "CHILD1_MONDO_PASSWORD"],
      deps,
    );
    expect(store.accounts?.[0]).toMatchObject({ service: "mondo", login_secret: "CHILD1_MONDO_LOGIN", origin: null });
    expect(out.slice(1)).toEqual([
      "Set the two credentials of this Account (encrypted on this computer):",
      "  admin set-credential --family <family id> --name CHILD1_MONDO_LOGIN",
      "  admin set-credential --family <family id> --name CHILD1_MONDO_PASSWORD",
    ]);
  });

  it("refuses a secret value in place of a name", async () => {
    const { deps, calls } = setup();
    await expect(
      runAdmin(["add-account", "--family", "f", "--child", "c", "--service", "librus", "--login-secret", "me@example.com", "--password-secret", "P_X"], deps),
    ).rejects.toThrow("secret NAME");
    expect(calls).toEqual([]);
  });

  it("refuses an unknown service", async () => {
    const args = ["add-account", "--family", "f", "--child", "c", "--service", "other", "--login-secret", "A_B", "--password-secret", "C_D"];
    await expect(runAdmin(args, setup().deps)).rejects.toThrow("--service");
  });

  it("adds an activity", async () => {
    const { deps, store } = setup();
    await runAdmin(["add-activity", "--family", "f", "--child", "c", "--name", "Chess", "--weekday", "2", "--start", "15:00", "--end", "16:00"], deps);
    expect(store.activities?.[0]).toMatchObject({ name: "Chess", weekday: 2, account_id: null, place: null });
  });

  it("refuses a bad weekday", async () => {
    const args = ["add-activity", "--family", "f", "--child", "c", "--name", "Chess", "--weekday", "9", "--start", "15:00", "--end", "16:00"];
    await expect(runAdmin(args, setup().deps)).rejects.toThrow("--weekday");
  });

  it("adds a Recipient with Children", async () => {
    const { deps, store } = setup();
    await runAdmin(["add-recipient", "--family", "f", "--chat-id", "1000001", "--language", "en", "--children", "c1,c2"], deps);
    expect(store.recipients?.[0]).toMatchObject({ telegram_chat_id: "1000001", child_ids: ["c1", "c2"] });
  });

  it("adds a Recipient without Children", async () => {
    const { deps, store } = setup();
    await runAdmin(["add-recipient", "--family", "f", "--chat-id", "1000001", "--language", "pl"], deps);
    expect(store.recipients?.[0]).toMatchObject({ child_ids: [] });
  });

  it("lists all tables, filtered by Family", async () => {
    const { deps, calls, out } = setup();
    await runAdmin(["list", "--family", "f1"], deps);
    expect(calls).toContain("select children select=*&family_id=eq.f1");
    expect(calls).toContain("select families select=*");
    expect(out).toContain("recipients: 0");
  });

  it("lists rows", async () => {
    const { deps, out } = setup();
    await runAdmin(["add-family", "--name", "Example Family"], deps);
    await runAdmin(["list"], deps);
    expect(out.some((line) => line.startsWith("  {") && line.includes("Example Family"))).toBe(true);
  });

  it("disables an Account", async () => {
    const { deps, calls, out } = setup();
    await runAdmin(["disable-account", "--id", "a1"], deps);
    expect(calls).toEqual(["update accounts id=eq.a1"]);
    expect(out).toEqual(["Disabled Account a1"]);
  });

  it("fails when the Account is missing", async () => {
    await expect(runAdmin(["disable-account", "--id", "missing"], setup().deps)).rejects.toThrow("No Account");
  });

  it("fails when an option is missing", async () => {
    await expect(runAdmin(["disable-account"], setup().deps)).rejects.toThrow("Missing option --id");
  });

  it("fails on an unknown command", async () => {
    await expect(runAdmin(["nope"], setup().deps)).rejects.toThrow("Usage");
    await expect(runAdmin([], setup().deps)).rejects.toThrow("Usage");
  });
});

describe("import-seed", () => {
  const seed = JSON.stringify({
    families: [{ id: "f1", name: "Example Family" }],
    children: [{ id: "c1", family_id: "f1", name: "Child One" }],
    accounts: [{ id: "a1", family_id: "f1", child_id: "c1", service: "librus", login_secret: "CHILD1_LIBRUS_LOGIN", password_secret: "CHILD1_LIBRUS_PASSWORD" }],
  });

  it("imports the tables in order", async () => {
    const { deps, calls, out } = setup({ "seed.json": seed });
    await runAdmin(["import-seed", "seed.json"], deps);
    expect(calls).toEqual(["insert families", "insert children", "insert accounts"]);
    expect(out).toContain("recipients: 0 imported");
  });

  it("needs a file", async () => {
    await expect(runAdmin(["import-seed"], setup().deps)).rejects.toThrow("Usage");
  });

  it("refuses a secret value in the seed and writes nothing", async () => {
    const bad = JSON.stringify({
      families: [{ id: "f1", name: "X" }],
      accounts: [{ login_secret: "someone@example.com", password_secret: "A_B" }],
    });
    const { deps, calls } = setup({ "bad.json": bad });
    await expect(runAdmin(["import-seed", "bad.json"], deps)).rejects.toThrow("secret NAME");
    expect(calls).toEqual([]);
  });
});

describe("make-watcher-key", () => {
  it("signs a JWT for the watcher role", async () => {
    const { deps, out } = setup({}, { SUPABASE_JWT_SECRET: "test-secret" });
    await runAdmin(["make-watcher-key"], deps);
    const token = out[1] ?? "";
    expect(token).toBe(signWatcherKey("test-secret", 1_700_000_000));
    const [header, payload, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toMatchObject({ role: "automations_watcher", iat: 1_700_000_000 });
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({ alg: "HS256", typ: "JWT" });
    expect(signature).toBe(createHmac("sha256", "test-secret").update(`${header}.${payload}`).digest("base64url"));
  });

  it("needs the JWT secret", async () => {
    await expect(runAdmin(["make-watcher-key"], setup().deps)).rejects.toThrow("SUPABASE_JWT_SECRET");
  });
});

describe("createRestClient", () => {
  function fake(status = 200) {
    const requests: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return new Response(status === 200 ? JSON.stringify([{ id: "1" }]) : "boom", { status });
    }) as unknown as typeof fetch;
    return { requests, client: createRestClient({ url: "https://example.test/", key: "service-key", fetch: fetcher }) };
  }

  it("sends the key and the rows", async () => {
    const { client, requests } = fake();
    expect(await client.insert("families", [{ name: "A" }])).toEqual([{ id: "1" }]);
    await client.select("children");
    await client.update("accounts", "id=eq.1", { enabled: false });
    expect(requests.map((r) => `${r.init.method} ${r.url}`)).toEqual([
      "POST https://example.test/rest/v1/families",
      "GET https://example.test/rest/v1/children?select=*",
      "PATCH https://example.test/rest/v1/accounts?id=eq.1",
    ]);
    expect(requests[0]?.init.body).toBe('[{"name":"A"}]');
    expect((requests[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer service-key");
  });

  it("throws on an error status", async () => {
    await expect(fake(500).client.select("children")).rejects.toThrow("GET children failed: 500 boom");
  });
});

describe("credentials", () => {
  const key = newCredentialKey();

  it("makes a new key", async () => {
    const { deps, out } = setup();
    await runAdmin(["new-credential-key"], deps);
    expect(out[1]).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it("encrypts a typed value and never prints it", async () => {
    const { deps, store, out } = setup({}, { CREDENTIAL_KEY: key });
    await runAdmin(["set-credential", "--family", "f1", "--name", "CHILD1_LIBRUS_LOGIN"], deps);
    const row = store.credentials?.[0];
    expect(row).toMatchObject({ family_id: "f1", name: "CHILD1_LIBRUS_LOGIN" });
    expect(String(row?.ciphertext)).not.toContain("typed value");
    await expect(decryptCredential(await importCredentialKey(key), "f1", "CHILD1_LIBRUS_LOGIN", String(row?.ciphertext))).resolves.toBe("typed value");
    expect(out.join("\n")).not.toContain("typed value");
  });

  it("reads the value from stdin with --stdin and drops one trailing newline", async () => {
    const { deps, store } = setup({}, { CREDENTIAL_KEY: key });
    await runAdmin(["set-credential", "--family", "f1", "--name", "X", "--stdin"], deps);
    const sealed = String(store.credentials?.[0]?.ciphertext);
    await expect(decryptCredential(await importCredentialKey(key), "f1", "X", sealed)).resolves.toBe("typed value-from-stdin");
  });

  it("needs the key, a valid name and a value", async () => {
    await expect(runAdmin(["set-credential", "--family", "f", "--name", "N"], setup().deps)).rejects.toThrow("CREDENTIAL_KEY");
    await expect(runAdmin(["set-credential", "--family", "f", "--name", "a b"], setup({}, { CREDENTIAL_KEY: key }).deps)).rejects.toThrow();
    await expect(runAdmin(["set-credential", "--family", "f", "--name", "N"], setup({}, { CREDENTIAL_KEY: key }, "").deps)).rejects.toThrow("empty");
  });

  it("lists names only and rotates the key", async () => {
    const next = newCredentialKey();
    const { deps, store, out } = setup({}, { CREDENTIAL_KEY: key, NEW_CREDENTIAL_KEY: next });
    await runAdmin(["set-credential", "--family", "f1", "--name", "A"], deps);
    await runAdmin(["list-credentials", "--family", "f1"], deps);
    expect(out.some((line) => line.startsWith("A  "))).toBe(true);
    await runAdmin(["rotate-credential-key", "--family", "f1"], deps);
    const row = store.credentials?.[0];
    await expect(decryptCredential(await importCredentialKey(next), "f1", "A", String(row?.ciphertext))).resolves.toBe("typed value");
    expect(out.at(-1)).toContain("Re-encrypted 1 credentials");
  });

  it("rotates nothing when there are no credentials", async () => {
    const { deps, out } = setup({}, { CREDENTIAL_KEY: key, NEW_CREDENTIAL_KEY: newCredentialKey() });
    await runAdmin(["rotate-credential-key", "--family", "f1"], deps);
    expect(out.at(-1)).toContain("Re-encrypted 0");
  });
});
