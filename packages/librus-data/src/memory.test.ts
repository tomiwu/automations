import { describe, expect, it } from "vitest";
import { runStorageContract } from "./contract.ts";
import { exampleConfig, FAMILY_ID } from "./fixtures.ts";
import { createMemoryStorage } from "./memory.ts";

runStorageContract("memory", async () => {
  let current = new Date("2025-01-01T00:00:00Z");
  const storage = createMemoryStorage({ now: () => current });
  return {
    storage,
    seedConfig: async (config) => storage.setConfig(config),
    seedFee: async (fee) => storage.setFee(fee),
    advanceDays: async (days) => {
      current = new Date(current.getTime() + days * 86_400_000);
    },
  };
});

describe("createMemoryStorage", () => {
  it("fails to load the config of an unknown Family", async () => {
    await expect(createMemoryStorage().loadConfig(FAMILY_ID)).rejects.toThrow("no config");
  });

  it("reads configs from the options and uses the clock by default", async () => {
    const storage = createMemoryStorage({ configs: [exampleConfig()] });
    expect((await storage.loadConfig(FAMILY_ID)).family.name).toBe("Example Family");
    await storage.recordItems(FAMILY_ID, "librus", ["a"]);
    expect((await storage.listItems(FAMILY_ID, "librus"))[0]?.firstSeen).toBeInstanceOf(Date);
  });

  it("ignores markDelivered for an unknown key", async () => {
    await expect(createMemoryStorage().markDelivered("none")).resolves.toBeUndefined();
  });
});
