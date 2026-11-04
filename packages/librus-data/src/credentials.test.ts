import { encryptCredential, importCredentialKey, newCredentialKey } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { createCredentialResolver, createSupabaseCredentialStore } from "./credentials.ts";

describe("createSupabaseCredentialStore", () => {
  it("loads all ciphertexts of the Family in one request with the key in the headers", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const store = createSupabaseCredentialStore({
      url: "https://x.supabase.co/",
      key: "{{secret:SUPABASE_KEY}}",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify([{ name: "SET", ciphertext: "v1.a.b" }, { name: "OTHER", ciphertext: "v1.c.d" }]));
      },
    });
    await expect(store.ciphertext("f 1", "SET")).resolves.toBe("v1.a.b");
    await expect(store.ciphertext("f 1", "OTHER")).resolves.toBe("v1.c.d");
    await expect(store.ciphertext("f 1", "NONE")).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://x.supabase.co/rest/v1/credentials?select=name,ciphertext&family_id=eq.f%201");
    expect(calls[0]?.init?.headers).toEqual({ apikey: "{{secret:SUPABASE_KEY}}", authorization: "Bearer {{secret:SUPABASE_KEY}}" });
  });

  it("throws on an error status without the body, and reads again after the error", async () => {
    let status = 401;
    const store = createSupabaseCredentialStore({
      url: "https://x",
      key: "k",
      fetch: async () => new Response(status === 200 ? '[{"name":"N","ciphertext":"c"}]' : "detail", { status }),
    });
    await expect(store.ciphertext("f", "N")).rejects.toThrow("Supabase GET credentials failed: 401");
    status = 200;
    await expect(store.ciphertext("f", "N")).resolves.toBe("c");
  });
});

describe("createCredentialResolver", () => {
  it("decrypts, caches and reports a missing credential", async () => {
    const key = await importCredentialKey(newCredentialKey());
    const sealed = await encryptCredential(key, "fam", "LOGIN", "value");
    let reads = 0;
    const resolve = createCredentialResolver(
      { ciphertext: async (_f, name) => (reads++, name === "LOGIN" ? sealed : undefined) },
      key,
      "fam",
    );
    await expect(resolve("LOGIN")).resolves.toBe("value");
    await expect(resolve("LOGIN")).resolves.toBe("value");
    expect(reads).toBe(1);
    await expect(resolve("NONE")).rejects.toThrow("Credential NONE is not set");
  });
});
