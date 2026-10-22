import { describe, expect, it } from "vitest";
import { loadKradziejkaConfig, parseKradziejkaConfig, saveAllowlist, saveKradziejkaConfig } from "./config.ts";

const credentialKey = btoa(String.fromCharCode(...new Uint8Array(32)));
const config = {
  supabaseUrl: "https://example.supabase.co",
  familyId: "00000000-0000-4000-8000-000000000001",
  credentialKey,
  allowlist: ["1000001"],
  adminToken: "example-admin-token",
};

describe("deployment config", () => {
  it("saves and loads the allowlist without returning secrets", async () => {
    const store = new Map<string, string>();
    const storage = { get: async (key: string) => store.get(key), set: async (key: string, value: string) => void store.set(key, value) };
    await expect(loadKradziejkaConfig(storage)).rejects.toThrow("./configure");
    const saved = await saveKradziejkaConfig(storage, { ...config, supabaseUrl: config.supabaseUrl + "/" });
    expect(saved).toMatchObject({ credentialKey: "set", adminToken: "set", allowlist: ["1000001"], confidenceThreshold: 0.6 });
    expect(JSON.stringify(saved)).not.toContain(credentialKey);
    await expect(loadKradziejkaConfig(storage)).resolves.toMatchObject({ allowlist: ["1000001"] });
    await expect(saveAllowlist(storage, "1000001,1000002")).resolves.toEqual(["1000001", "1000002"]);
  });

  it("accepts an object that storage already parsed", async () => {
    await expect(loadKradziejkaConfig({ get: async () => config, set: async () => undefined })).resolves.toMatchObject({ familyId: config.familyId });
  });

  it("rejects bad input", () => {
    expect(() => parseKradziejkaConfig(null)).toThrow("object");
    expect(() => parseKradziejkaConfig({ ...config, extra: 1 })).toThrow("Unknown config keys");
    expect(() => parseKradziejkaConfig({ ...config, supabaseUrl: "http://x" })).toThrow("supabaseUrl");
    expect(() => parseKradziejkaConfig({ ...config, familyId: "a b" })).toThrow("familyId");
    expect(() => parseKradziejkaConfig({ ...config, credentialKey: "short" })).toThrow("credentialKey");
    expect(() => parseKradziejkaConfig({ ...config, adminToken: "short" })).toThrow("adminToken");
    expect(() => parseKradziejkaConfig({ ...config, confidenceThreshold: 2 })).toThrow("confidenceThreshold");
    expect(parseKradziejkaConfig({ ...config, confidenceThreshold: 0.8 }).confidenceThreshold).toBe(0.8);
  });
});
