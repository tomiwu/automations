import { describe, expect, it } from "vitest";
import { claimUpdate, releaseUpdate } from "./updates.ts";
import type { KeyValue } from "./state.ts";

function kv(initial?: string): KeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set("seen-update-ids", initial);
  return {
    data,
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
  };
}

describe("update guard", () => {
  it("claims an id once and allows it again after release", async () => {
    const store = kv();
    expect(await claimUpdate(store, 7)).toBe(true);
    expect(await claimUpdate(store, 7)).toBe(false);
    await releaseUpdate(store, 7);
    expect(await claimUpdate(store, 7)).toBe(true);
  });

  it("rejects an id that is not a safe non-negative integer", async () => {
    const store = kv();
    expect(await claimUpdate(store, -1)).toBe(false);
    expect(await claimUpdate(store, 1.5)).toBe(false);
    expect(store.data.size).toBe(0);
  });

  it("ignores stored data that is not a list of text", async () => {
    expect(await claimUpdate(kv("not json"), 1)).toBe(true);
    expect(await claimUpdate(kv('{"a":1}'), 1)).toBe(true);
    const mixed = kv('["1",2]');
    expect(await claimUpdate(mixed, 1)).toBe(false);
    expect(await claimUpdate(mixed, 2)).toBe(true);
  });

  it("keeps only the newest ids", async () => {
    const store = kv();
    for (let id = 0; id < 401; id += 1) await claimUpdate(store, id);
    expect(JSON.parse(store.data.get("seen-update-ids") ?? "[]")).toHaveLength(400);
    expect(await claimUpdate(store, 0)).toBe(true);
  });
});
