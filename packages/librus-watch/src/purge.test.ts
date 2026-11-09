import { createMemoryStorage } from "@automations/librus-data";
import { countFetches, fakeRuntime } from "@automations/shared";
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

  it("keeps every Item detail", async () => {
    let current = new Date("2026-01-01T00:00:00Z");
    const storage = createMemoryStorage({ now: () => current });
    await storage.recordDetails([
      {
        familyId: "f1",
        scope: "messages:child-one",
        kind: "message",
        childId: "c1",
        sourceId: "m1",
        date: null,
        startTime: null,
        endTime: null,
        title: "Example message",
        text: "Example text",
        sender: "Teacher One",
        subject: null,
        category: null,
        sourceUpdatedAt: null,
      },
    ]);
    await storage.enqueueNotification({ key: "old", familyId: "f1", chatId: "1000001", text: "Hello" });
    await storage.markDelivered("old");
    current = new Date(current.getTime() + 400 * DAY_MS);
    expect(await runPurge({ storage, runtime: fakeRuntime() })).toBe(1);
    expect(await storage.listDetails("f1")).toHaveLength(1);
  });

  it("keeps every Journal event", async () => {
    let current = new Date("2026-01-01T00:00:00Z");
    const storage = createMemoryStorage({ now: () => current });
    await storage.appendEvents([
      {
        familyId: "f1", childId: "c1", stream: "lesson:c1:2026-01-02:1", seq: 1, kind: "lesson", day: "2026-01-02",
        eventType: "LessonScheduled", payload: { subject: "Math" }, contentHash: "h1", source: "librus-watch",
      },
    ]);
    await storage.enqueueNotification({ key: "old", familyId: "f1", chatId: "1000001", text: "Hello" });
    await storage.markDelivered("old");
    current = new Date(current.getTime() + 400 * DAY_MS);
    await runPurge({ storage, runtime: fakeRuntime() });
    expect(await storage.listEvents("f1")).toHaveLength(1);
  });

  it("logs the fetch count when it has a counter", async () => {
    const counter = countFetches(async () => new Response(""));
    await counter.fetch("https://project.example.test/rest/v1/outbox");
    const runtime = fakeRuntime();
    await runPurge({ storage: createMemoryStorage(), runtime, counter });
    expect(runtime.logs.at(-1)?.message).toBe("fetches total=1 project.example.test=1");
  });

  it("uses a limit of 30 days", () => {
    expect(PURGE_AFTER_DAYS).toBe(30);
  });
});
