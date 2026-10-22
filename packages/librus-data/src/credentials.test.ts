import { encryptCredential, importCredentialKey, newCredentialKey } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { createCredentialResolver, createSupabaseCredentialStore } from "./credentials.ts";

describe("createSupabaseCredentialStore", () => {
  it("selects one ciphertext by Family and name with the key in the headers", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const store = createSupabaseCredentialStore({
      url: "https://x.supabase.co/",
      key: "{{secret:SUPABASE_KEY}}",
      fetch: async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(url.includes("name=eq.SET") ? [{ ciphertext: "v1.a.b" }] : []));
      },
    });
    await expect(store.ciphertext("f 1", "SET")).resolves.toBe("v1.a.b");
    await expect(store.ciphertext("f", "NONE")).resolves.toBeUndefined();
    expect(calls[0]?.url).toBe("https://x.supabase.co/rest/v1/credentials?select=ciphertext&family_id=eq.f%201&name=eq.SET");
    expect(calls[0]?.init?.headers).toEqual({ apikey: "{{secret:SUPABASE_KEY}}", authorization: "Bearer {{secret:SUPABASE_KEY}}" });
  });

  it("throws on an error status without the body", async () => {
    const store = createSupabaseCredentialStore({ url: "https://x", key: "k", fetch: async () => new Response("detail", { status: 401 }) });
    await expect(store.ciphertext("f", "N")).rejects.toThrow("Supabase GET credentials failed: 401");
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
