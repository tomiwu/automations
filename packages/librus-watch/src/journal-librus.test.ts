import { createMemoryStorage } from "@automations/librus-data";
import { describe, expect, it } from "vitest";
import { appendLibrusJournal } from "./journal-librus.ts";
import { CHILD1, FAMILY_ID, fakeSource, lesson } from "./test-fixtures.ts";
import type { HomeworkItem } from "./types.ts";

const NOW = new Date("2026-01-07T10:00:00Z");

const homework = (id: string, extra: Partial<HomeworkItem> = {}): HomeworkItem => ({
  id,
  hash: "h",
  category: "Homework",
  date: "2026-01-08",
  content: "Unit 3",
  subject: "Math",
  teacher: "Teacher One",
  ...extra,
});

function setup() {
  const storage = createMemoryStorage({ now: () => NOW });
  const source = fakeSource();
  const logs: string[] = [];
  const pass = (items: HomeworkItem[] | null = []) =>
    appendLibrusJournal({ storage, familyId: FAMILY_ID, childId: CHILD1, source, timezone: "UTC", now: NOW, homework: items ?? undefined, log: (m) => logs.push(m) });
  const types = async (prefix: string) =>
    (await storage.listEvents(FAMILY_ID, { streams: undefined })).filter((e) => e.stream.startsWith(prefix)).map((e) => e.eventType);
  return { storage, source, logs, pass, types };
}

describe("appendLibrusJournal lessons", () => {
  it("appends LessonScheduled and one CheckCompleted, then only CheckCompleted for the same data", async () => {
    const { source, pass, types, logs } = setup();
    source.lessons = [lesson("2026-01-08", 1, "Math")];
    expect(await pass()).toBe(2);
    expect(await pass()).toBe(1);
    expect(await types("lesson:")).toEqual(["LessonScheduled"]);
    expect(await types("check:")).toEqual(["CheckCompleted", "CheckCompleted"]);
    expect(logs).toEqual(["journal: +2 events", "journal: +1 events"]);
  });

  it("follows cancel, substitution, restore and a vanished Lesson", async () => {
    const { source, pass, types } = setup();
    source.lessons = [lesson("2026-01-08", 1, "Math")];
    await pass();
    source.lessons = [lesson("2026-01-08", 1, "Math", { status: "cancelled" })];
    await pass();
    source.lessons = [lesson("2026-01-08", 1, "Math", { status: "substitution", substituteTeacher: "Teacher Two" })];
    await pass();
    source.lessons = [lesson("2026-01-08", 1, "Math", { status: "substitution", substituteTeacher: "Teacher Three" })];
    await pass();
    source.lessons = [lesson("2026-01-08", 1, "Math", { status: "substitution", substituteTeacher: "Teacher Three", room: "2" })];
    await pass();
    source.lessons = [lesson("2026-01-08", 1, "Math")];
    await pass();
    source.lessons = [];
    await pass();
    expect(await types("lesson:")).toEqual([
      "LessonScheduled",
      "LessonCancelled",
      "LessonSubstituted",
      "LessonSubstituted",
      "LessonChanged",
      "LessonRestored",
      "LessonVanished",
    ]);
  });

  it("types an added cancelled or substituted Lesson", async () => {
    const { source, pass, types } = setup();
    source.lessons = [
      lesson("2026-01-08", 1, "Math", { status: "cancelled" }),
      lesson("2026-01-08", 2, "Art", { status: "substitution", substituteTeacher: "Teacher Two" }),
    ];
    await pass();
    expect((await types("lesson:")).sort()).toEqual(["LessonCancelled", "LessonSubstituted"]);
  });

  it("gives no lesson event and no LessonVanished when the timetable failed", async () => {
    const { source, pass, types } = setup();
    source.lessons = [lesson("2026-01-08", 1, "Math")];
    await pass();
    source.timetableError = "Librus down";
    await pass();
    expect(await types("lesson:")).toEqual(["LessonScheduled"]);
  });

  it("keeps a Lesson outside the 14-day scope", async () => {
    const { source, pass, types } = setup();
    source.lessons = [lesson("2026-01-06", 1, "Math")];
    await pass();
    source.lessons = [];
    await pass();
    expect(await types("lesson:")).toEqual(["LessonScheduled"]);
  });
});

describe("appendLibrusJournal homework", () => {
  it("records a test with its Lesson, then a changed content, then a vanished entry", async () => {
    const { source, storage, pass, types } = setup();
    source.lessons = [lesson("2026-01-08", 2, "Math")];
    await pass([homework("77", { category: "Test" })]);
    const [head] = await storage.listHeads(FAMILY_ID, { kinds: ["homework"] });
    expect(head?.payload).toEqual({
      librusId: "77", category: "Test", isTest: true, date: "2026-01-08", subject: "Math", content: "Unit 3",
      teacher: "Teacher One", lessonNo: "2", start: "09:00", end: "09:45",
    });
    await pass([homework("77", { category: "Test", content: "Unit 4" })]);
    await pass([]);
    expect(await types("homework:")).toEqual(["HomeworkAdded", "HomeworkChanged", "HomeworkVanished"]);
  });

  it("takes the Lesson from the head when the timetable failed, without a change event", async () => {
    const { source, pass, types } = setup();
    source.lessons = [lesson("2026-01-08", 2, "Math")];
    await pass([homework("77")]);
    source.timetableError = "Librus down";
    await pass([homework("77")]);
    expect(await types("homework:")).toEqual(["HomeworkAdded"]);
    const check = (await types("check:")).length;
    expect(check).toBe(2);
  });

  it("gives no homework event and no vanished event when the homework Watcher failed", async () => {
    const { source, pass, types } = setup();
    source.lessons = [lesson("2026-01-08", 1, "Math")];
    await pass([homework("77")]);
    await pass(null);
    expect(await types("homework:")).toEqual(["HomeworkAdded"]);
    const payloads = (await types("check:")).length;
    expect(payloads).toBe(2);
  });

  it("does nothing when both parts failed", async () => {
    const { source, pass, storage } = setup();
    source.timetableError = "Librus down";
    expect(await pass(null)).toBe(0);
    expect(await storage.listEvents(FAMILY_ID)).toEqual([]);
  });
});
