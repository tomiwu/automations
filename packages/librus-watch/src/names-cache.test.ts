import { describe, expect, it } from "vitest";
import { createNameCache, nameCacheKey, nameOptionsFor } from "./names-cache.ts";

const NOW = new Date("2026-01-07T10:00:00Z");

function memoryStore(initial?: unknown) {
  const data = new Map<string, unknown>(initial === undefined ? [] : [["k", initial]]);
  const writes: string[] = [];
  return {
    data,
    writes,
    get: async (key: string) => data.get(key),
    set: async (key: string, value: string) => {
      writes.push(value);
      data.set(key, value);
    },
  };
}

describe("createNameCache", () => {
  it("builds the key of an Account", () => {
    expect(nameCacheKey("a1")).toBe("librus-names:a1");
    const store = memoryStore();
    expect(nameOptionsFor(store, "a1")).toEqual({ store, key: "librus-names:a1" });
    expect(nameOptionsFor(undefined, "a1")).toBeUndefined();
  });

  it("finds a saved name after a flush and a reload", async () => {
    const store = memoryStore();
    const cache = createNameCache({ store, key: "k" }, () => NOW);
    expect(await cache.find("Users/1")).toBeUndefined();
    await cache.save("Users/1", "Teacher One");
    await cache.flush();
    const again = createNameCache({ store, key: "k" }, () => NOW);
    expect(await again.find("Users/1")).toBe("Teacher One");
  });

  it("writes once for many names and not at all when nothing is new", async () => {
    const store = memoryStore();
    const cache = createNameCache({ store, key: "k" }, () => NOW);
    await cache.flush();
    await cache.find("Users/1");
    await cache.save("Users/1", "A");
    await cache.save("Users/2", "B");
    await cache.flush();
    await cache.flush();
    expect(store.writes).toHaveLength(1);
  });

  it("drops the old names when it writes", async () => {
    const old = { "Users/1": { name: "Old", at: NOW.getTime() - 8 * 86_400_000 } };
    const store = memoryStore(old);
    const cache = createNameCache({ store, key: "k" }, () => NOW);
    expect(await cache.find("Users/1")).toBeUndefined();
    await cache.save("Users/2", "New");
    await cache.flush();
    expect(Object.keys(JSON.parse(store.writes[0] ?? "{}"))).toEqual(["Users/2"]);
  });

  it("works with a damaged or failing storage", async () => {
    for (const stored of ["not json", 5, [1], ""]) {
      const cache = createNameCache({ store: memoryStore(stored), key: "k" }, () => NOW);
      expect(await cache.find("Users/1")).toBeUndefined();
    }
    const broken = {
      get: async () => {
        throw new Error("down");
      },
      set: async () => {
        throw new Error("down");
      },
    };
    const cache = createNameCache({ store: broken, key: "k" }, () => NOW);
    expect(await cache.find("Users/1")).toBeUndefined();
    await cache.save("Users/1", "A");
    await expect(cache.flush()).resolves.toBeUndefined();
  });
});
