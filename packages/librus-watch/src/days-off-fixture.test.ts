import { createMemoryStorage, type NewJournalEvent } from "@automations/librus-data";
import type { Messenger } from "./deliver.ts";
import { describe, expect, it } from "vitest";
import { CLASS_FREE_DAYS, fakeLibrusRuntime, SCHOOL_FREE_DAYS, type FixtureData } from "./fixtures/days-off-2026-11.ts";
import { runLibrusWatch } from "./run.ts";
import { createLibrusSource } from "./source.ts";
import { storedLessonsExport } from "./stored-lessons.ts";
import { CHILD1, FAMILY_ID, testConfig } from "./test-fixtures.ts";

// Issue #201: Librus-shaped fixture data → producer → memory storage → ./stored-lessons. No network.
const NOW = new Date("2026-11-09T05:00:00Z");

function setup(data: FixtureData) {
  const storage = createMemoryStorage({ configs: [testConfig()], now: () => NOW });
  const librus = fakeLibrusRuntime(NOW, data);
  const messenger: Messenger = { send: async () => undefined };
  const deps = {
    runtime: librus,
    storage,
    messenger,
    familyId: FAMILY_ID,
    createSource: (account: Parameters<typeof createLibrusSource>[1], timezone: string) => createLibrusSource(librus, account, { timezone }),
  };
  const produce = () => runLibrusWatch(deps);
  const lessons = async (from = "2026-11-09", to = "2026-11-20") =>
    (await storedLessonsExport({ runtime: librus, storage, familyId: FAMILY_ID }, { childId: CHILD1, from, to })).lessons;
  const cancelledDays = async () => [...new Set((await lessons()).filter((l) => l.cancelled).map((l) => l.date))];
  return { storage, librus, produce, lessons, cancelledDays };
}

describe("days off from Librus fixture data", () => {
  it("cancels all Lessons on 2026-11-12 and 2026-11-13 with the day_off reason (D1, D2)", async () => {
    const { produce, lessons, cancelledDays } = setup({ schoolFreeDays: SCHOOL_FREE_DAYS });
    expect(await produce()).toEqual([]);
    const breakLessons = (await lessons()).filter((l) => l.date === "2026-11-12" || l.date === "2026-11-13");
    expect(breakLessons).toHaveLength(4);
    for (const lesson of breakLessons) {
      expect(lesson).toMatchObject({
        status: "cancelled",
        cancelled: true,
        cancelReason: { reason: "day_off", sourceStream: `item:schoolFreeDays:${CHILD1}:701`, sourceId: "701" },
      });
    }
    expect(await cancelledDays()).toEqual(["2026-11-12", "2026-11-13"]);
  });

  it("keeps the Lessons on 2026-11-11 and 2026-11-16, and the free-text note cancels nothing (D4)", async () => {
    const { produce, lessons } = setup({ schoolFreeDays: SCHOOL_FREE_DAYS });
    await produce();
    const kept = (await lessons()).filter((l) => l.date === "2026-11-11" || l.date === "2026-11-16");
    expect(kept.map((l) => [l.date, l.status, l.cancelled])).toEqual([
      ["2026-11-11", "normal", false], ["2026-11-11", "normal", false],
      ["2026-11-16", "normal", false], ["2026-11-16", "normal", false],
    ]);
  });

  it("a ClassFreeDays entry cancels only the Lessons of that class day", async () => {
    const { produce, cancelledDays } = setup({ classFreeDays: CLASS_FREE_DAYS });
    await produce();
    expect(await cancelledDays()).toEqual(["2026-11-18"]);
  });

  it("with no days off and only the free-text note, nothing is cancelled (D4)", async () => {
    const { produce, cancelledDays } = setup({});
    await produce();
    expect(await cancelledDays()).toEqual([]);
  });

  it("a second producer run appends no Lesson or day-off events and removes nothing (D5)", async () => {
    const { produce, storage, cancelledDays } = setup({ schoolFreeDays: SCHOOL_FREE_DAYS });
    await produce();
    const first = await storage.listEvents(FAMILY_ID);
    await produce();
    const second = await storage.listEvents(FAMILY_ID);
    const kept = (events: typeof first) => events.filter((e) => e.kind === "lesson" || e.kind === "dayOff").map((e) => `${e.stream}#${e.seq}`);
    expect(kept(second)).toEqual(kept(first));
    expect(second.length).toBeGreaterThanOrEqual(first.length);
    expect(first.every((event) => second.some((other) => other.stream === event.stream && other.seq === event.seq))).toBe(true);
    expect(await cancelledDays()).toEqual(["2026-11-12", "2026-11-13"]);
  });

  it("a day off that comes after the first run also cancels its Lessons", async () => {
    const data: FixtureData = {};
    const { produce, cancelledDays } = setup(data);
    await produce();
    expect(await cancelledDays()).toEqual([]);
    data.schoolFreeDays = SCHOOL_FREE_DAYS;
    await produce();
    expect(await cancelledDays()).toEqual(["2026-11-12", "2026-11-13"]);
  });

  it("makes no request outside the fake Librus", async () => {
    const { produce, librus } = setup({ schoolFreeDays: SCHOOL_FREE_DAYS });
    await produce();
    const hosts = new Set(librus.requests.map((r) => new URL(r.input).host));
    expect([...hosts].sort()).toEqual(["api.librus.pl", "portal.librus.pl", "school.example.org"]);
    await expect(librus.fetch("https://elsewhere.example.net/")).rejects.toThrow("No network in this test");
  });
});

const MESSAGE_STREAM = `item:messages:${CHILD1}:m1`;
const MANUAL_STREAM = `item:manualDaysOff:${CHILD1}:2026-11-12`;

const itemEvent = (stream: string, kind: "message" | "dayOff", day: string, payload: Record<string, unknown>, eventType = "ItemRecorded"): NewJournalEvent => ({
  familyId: FAMILY_ID, childId: CHILD1, stream, seq: 1, kind, day, eventType, payload, contentHash: `hash-${stream}-${eventType}`, source: "test",
});

const messageEvent = () => itemEvent(MESSAGE_STREAM, "message", "2026-11-09", { scope: `messages:${CHILD1}`, sourceId: "m1", kind: "message", date: "2026-11-09", title: "Notice", text: "No school on 12 and 13 November" });

const manualPayload = { scope: `manualDaysOff:${CHILD1}`, sourceId: "2026-11-12", kind: "dayOff", date: "2026-11-12", text: "2026-11-12 - 2026-11-13\nday off (message)", title: "Dzień wolny", sourceStream: MESSAGE_STREAM };

describe("manual day off from a message (D7)", () => {
  async function seeded(withManual: boolean) {
    const run = setup({});
    await run.produce();
    await run.storage.appendEvents([messageEvent(), ...(withManual ? [itemEvent(MANUAL_STREAM, "dayOff", "2026-11-12", manualPayload)] : [])]);
    return run;
  }

  it("without the manual Item, all Lessons stay normal", async () => {
    const { lessons } = await seeded(false);
    const all = await lessons();
    expect(all.length).toBeGreaterThan(4);
    expect(all.every((l) => l.status === "normal" && !l.cancelled)).toBe(true);
  });

  it("with the manual Item, the Lessons of both days are cancelled with the manual source", async () => {
    const { lessons, cancelledDays } = await seeded(true);
    const all = await lessons();
    const off = all.filter((l) => l.date === "2026-11-12" || l.date === "2026-11-13");
    expect(off).toHaveLength(4);
    for (const lesson of off) {
      expect(lesson).toMatchObject({ status: "cancelled", cancelled: true, cancelReason: { reason: "day_off", sourceStream: MANUAL_STREAM, sourceId: "2026-11-12" } });
    }
    expect(await cancelledDays()).toEqual(["2026-11-12", "2026-11-13"]);
    expect(all.filter((l) => !off.includes(l)).every((l) => l.status === "normal")).toBe(true);
  });

  it("a withdrawn head cancels nothing", async () => {
    const { lessons, cancelledDays, storage } = await seeded(true);
    await storage.appendEvents([{ ...itemEvent(MANUAL_STREAM, "dayOff", "2026-11-12", { ...manualPayload, withdrawn: true }, "ItemChanged"), seq: 2 }]);
    expect(await cancelledDays()).toEqual([]);
    expect((await lessons()).every((l) => l.status === "normal")).toBe(true);
  });

  it("a full watcher pass does not mark the manual stream or the message stream as vanished", async () => {
    const { produce, storage } = await seeded(true);
    await produce();
    await produce();
    const events = await storage.listEvents(FAMILY_ID, { streams: [MANUAL_STREAM, MESSAGE_STREAM] });
    expect(events.map((e) => [e.stream, e.seq, e.eventType]).sort()).toEqual([[MANUAL_STREAM, 1, "ItemRecorded"], [MESSAGE_STREAM, 1, "ItemRecorded"]]);
    const heads = await storage.listHeads(FAMILY_ID, { streams: [MANUAL_STREAM] });
    expect(heads[0]?.eventType.endsWith("Vanished")).toBe(false);
  });
});
