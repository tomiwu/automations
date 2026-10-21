import { createMemoryStorage } from "@automations/librus-data";
import { fakeRuntime } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { PURGE_AFTER_DAYS, runPurge } from "./purge.ts";

const DAY_MS = 86_400_000;

describe("runPurge", () => {
  it("removes Outbox entries that were delivered more than 30 days ago", async () => {
    let current = new Date("2026-01-01T00:00:00Z");
    const storage = createMemoryStorage({ now: () => current });
    const entry = { familyId: "f1", chatId: "1000001", text: "Hello" };
    await storage.enqueueNotification({ ...entry, key: "old" });
    await storage.markDelivered("old");
    current = new Date(current.getTime() + 20 * DAY_MS);
    await storage.enqueueNotification({ ...entry, key: "recent" });
    await storage.markDelivered("recent");
    current = new Date(current.getTime() + 15 * DAY_MS);
    const runtime = fakeRuntime();
    expect(await runPurge({ storage, runtime })).toBe(1);
    expect(runtime.logs).toEqual([{ level: "info", message: "purged 1 delivered Outbox entries" }]);
    expect(await runPurge({ storage, runtime })).toBe(0);
  });

  it("uses a limit of 30 days", () => {
    expect(PURGE_AFTER_DAYS).toBe(30);
  });
});
