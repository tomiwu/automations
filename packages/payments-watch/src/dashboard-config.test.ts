import { describe, expect, it } from "vitest";
import { loadDashboardAllowlist, parseDashboardAllowlist, saveDashboardAllowlist } from "./dashboard-config.ts";

const DIGEST = "a".repeat(64);

function memoryStore() {
  const data = new Map<string, unknown>();
  return {
    get: async (key: string) => data.get(key),
    set: async (key: string, value: string) => void data.set(key, value),
  };
}

describe("parseDashboardAllowlist", () => {
  it("accepts users with a token digest", () => {
    expect(parseDashboardAllowlist([{ user: "adult-one", tokenDigest: DIGEST }])).toEqual([{ user: "adult-one", tokenDigest: DIGEST }]);
  });

  it("rejects a value that is not a list", () => {
    expect(() => parseDashboardAllowlist("adult-one")).toThrow("allowlist must be a list");
  });

  it("rejects a bad entry", () => {
    expect(() => parseDashboardAllowlist([null])).toThrow("user and a tokenDigest");
    expect(() => parseDashboardAllowlist([{ user: "a b", tokenDigest: DIGEST }])).toThrow("user must be");
    expect(() => parseDashboardAllowlist([{ user: "adult-one", tokenDigest: "abc" }])).toThrow("tokenDigest must be");
  });
});

describe("allowlist storage", () => {
  it("gives an empty list when nothing is saved", async () => {
    expect(await loadDashboardAllowlist(memoryStore())).toEqual([]);
  });

  it("saves and loads the list", async () => {
    const store = memoryStore();
    await saveDashboardAllowlist(store, [{ user: "adult-one", tokenDigest: DIGEST }]);
    expect(await loadDashboardAllowlist(store)).toEqual([{ user: "adult-one", tokenDigest: DIGEST }]);
  });
});
