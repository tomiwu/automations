import { createMemoryStorage } from "@automations/librus-data";
import { describe, expect, it } from "vitest";
import { BASELINE_ID, announcements, formatSessionNotification, runWatcher, startsWithin24Hours, type WatcherCheck } from "./engine.ts";
import { toItem } from "./sessions.ts";
import { CHILD1, FAMILY_ID, fakeSessionSource, session, testConfig } from "./test-fixtures.ts";

const NOW = new Date("2026-10-20T08:00:00Z");

function setup(now: Date = NOW) {
  const config = testConfig();
  const storage = createMemoryStorage({ configs: [config] });
  const source = fakeSessionSource();
  const check: WatcherCheck = {
    familyId: FAMILY_ID,
    child: config.children[0]!,
    recipients: config.recipients.filter((r) => r.child_ids.includes(CHILD1)),
    scope: "activenow:a1",
    storage,
    source,
    now,
    timezone: "UTC",
  };
  const texts = async () => (await storage.pendingNotifications(FAMILY_ID)).map((e) => `${e.chatId}|${e.text}`);
  return { storage, source, check, texts };
}

describe("runWatcher", () => {
  it("records a silent Baseline on the first run", async () => {
    const { source, check, texts, storage } = setup();
    source.current = [session({ status: "cancelled" })];
    await runWatcher(check);
    expect(await texts()).toEqual([]);
    expect((await storage.knownItemIds(FAMILY_ID, "activenow:a1")).has(BASELINE_ID)).toBe(true);
  });

  it("marks an empty scope as baselined", async () => {
    const { source, check, texts } = setup();
    await runWatcher(check);
    source.current = [session()];
    await runWatcher(check);
    source.current = [session({ status: "cancelled" })];
    await runWatcher(check);
    expect(await texts()).toHaveLength(2);
  });

  it("renders each Notification in the language of its Recipient", async () => {
    const { source, check, texts } = setup();
    source.current = [session()];
    await runWatcher(check);
    source.current = [session({ status: "cancelled" })];
    await runWatcher(check);
    expect(await texts()).toEqual([
      "1000001|Class cancelled for Child One: Choir, 2026-10-27 15:00-16:00, Example Hall",
      "1000002|Zajęcia odwołane dla Child One: Choir, 2026-10-27 15:00-16:00, Example Hall",
    ]);
  });

  it("does not repeat a Notification on the next run", async () => {
    const { source, check, texts } = setup();
    source.current = [session()];
    await runWatcher(check);
    source.current = [session({ status: "moved", start: "2026-10-28T15:00", end: "2026-10-28T16:00" })];
    await runWatcher(check);
    await runWatcher(check);
    expect(await texts()).toHaveLength(2);
  });

  it("records a new Session silently and ignores a Session that goes back to planned", async () => {
    const { source, check, texts } = setup();
    source.current = [session()];
    await runWatcher(check);
    source.current = [session(), session({ id: "other", status: "cancelled" })];
    await runWatcher(check);
    expect(await texts()).toEqual([]);
    source.current = [session({ status: "cancelled" })];
    await runWatcher(check);
    source.current = [session()];
    const before = (await texts()).length;
    await runWatcher(check);
    expect(await texts()).toHaveLength(before);
  });

  it("marks a change within 24 hours as urgent", async () => {
    const { source, check, texts } = setup(new Date("2026-10-27T10:00:00Z"));
    source.current = [session()];
    await runWatcher(check);
    source.current = [session({ status: "cancelled" })];
    await runWatcher(check);
    expect((await texts())[0]).toBe("1000001|URGENT: Class cancelled for Child One: Choir, 2026-10-27 15:00-16:00, Example Hall");
  });

  it("queues nothing and records nothing when the source fails", async () => {
    const { source, check, storage } = setup();
    source.error = new Error("down");
    await expect(runWatcher(check)).rejects.toThrow("down");
    expect((await storage.knownItemIds(FAMILY_ID, "activenow:a1")).size).toBe(0);
  });
});

describe("startsWithin24Hours", () => {
  it("is true from now up to 24 hours ahead, in the time zone", () => {
    const now = new Date("2026-10-20T08:00:00Z");
    expect(startsWithin24Hours("2026-10-20T08:00", now, "UTC")).toBe(true);
    expect(startsWithin24Hours("2026-10-21T08:00", now, "UTC")).toBe(true);
    expect(startsWithin24Hours("2026-10-21T08:01", now, "UTC")).toBe(false);
    expect(startsWithin24Hours("2026-10-20T07:59", now, "UTC")).toBe(false);
    expect(startsWithin24Hours("2026-10-20T10:00", now, "Europe/Warsaw")).toBe(true);
    expect(startsWithin24Hours("2026-10-20T09:59", now, "Europe/Warsaw")).toBe(false);
  });
});

describe("formatSessionNotification", () => {
  it("leaves out the place when there is none", () => {
    expect(formatSessionNotification("en", session({ status: "moved", place: "" }), false)).toBe(
      "Class moved for Child One: Choir, 2026-10-27 15:00-16:00",
    );
  });
});

describe("announcements", () => {
  it("returns only changed Sessions that are cancelled or moved", () => {
    const planned = toItem(session());
    const cancelled = toItem(session({ status: "cancelled" }));
    const known = new Set([`${planned.id}@${planned.hash}`]);
    expect(announcements([cancelled], known)).toEqual([cancelled]);
    expect(announcements([planned], known)).toEqual([]);
  });
});
