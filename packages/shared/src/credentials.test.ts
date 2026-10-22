import { describe, expect, it } from "vitest";
import { decryptCredential, encryptCredential, importCredentialKey, newCredentialKey } from "./credentials.ts";

describe("credentials", () => {
  it("round-trips and binds the ciphertext to the Family and name", async () => {
    const key = await importCredentialKey(newCredentialKey());
    const sealed = await encryptCredential(key, "f1", "LOGIN", "pa ss ł");
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(sealed).not.toContain("pa ss");
    await expect(decryptCredential(key, "f1", "LOGIN", sealed)).resolves.toBe("pa ss ł");
    await expect(decryptCredential(key, "f2", "LOGIN", sealed)).rejects.toThrow("does not decrypt");
    await expect(decryptCredential(key, "f1", "OTHER", sealed)).rejects.toThrow("does not decrypt");
    const other = await importCredentialKey(newCredentialKey());
    await expect(decryptCredential(other, "f1", "LOGIN", sealed)).rejects.toThrow("does not decrypt");
  });

  it("uses a new IV each time", async () => {
    const key = await importCredentialKey(newCredentialKey());
    expect(await encryptCredential(key, "f", "N", "v")).not.toBe(await encryptCredential(key, "f", "N", "v"));
  });

  it("rejects bad keys and formats", async () => {
    await expect(importCredentialKey("!!!")).rejects.toThrow("not base64");
    await expect(importCredentialKey(btoa("short"))).rejects.toThrow("32 bytes");
    const key = await importCredentialKey(newCredentialKey());
    await expect(decryptCredential(key, "f", "N", "v2.a.b")).rejects.toThrow("unknown format");
    await expect(decryptCredential(key, "f", "N", "v1.a")).rejects.toThrow("unknown format");
  });
});
