import { createSupabaseStorage, type NewJournalEvent } from "@automations/librus-data";
import { createFakePostgrest } from "@automations/librus-data/fake-postgrest";
import { exampleConfig, FAMILY_ID } from "@automations/librus-data/fixtures";
import { countFetches, fakeRuntime } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { storedLessonsExport } from "./stored-lessons.ts";

const SUPABASE = "https://project.example.test";
const KEY = "test-key";
const NOW = new Date("2026-01-10T10:00:00Z");

type Event = Partial<NewJournalEvent> & Pick<NewJournalEvent, "stream" | "kind" | "payload">;

let counter = 0;
const event = (childId: string, e: Event): NewJournalEvent => ({
  familyId: FAMILY_ID, childId, seq: 1, day: null, eventType: "Added", contentHash: `h${counter++}`, source: "librus-watch", ...e,
});

const lessonEvent = (childId: string, date: string, period: number, extra: Record<string, unknown> = {}, e: Partial<NewJournalEvent> = {}) =>
  event(childId, {
    stream: `lesson:${childId}:${date}:${period}`, kind: "lesson", day: date, eventType: "LessonScheduled",
    payload: { date, period, start: "08:00", end: "08:45", subject: "Math", teacher: "Teacher One", room: "1", status: "normal", substituteTeacher: "", ...extra },
    ...e,
  });

const homeworkEvent = (childId: string, id: string, date: string, extra: Record<string, unknown> = {}, e: Partial<NewJournalEvent> = {}) =>
  event(childId, {
    stream: `homework:${childId}:${id}`, kind: "homework", day: date, eventType: "HomeworkAdded",
    payload: { librusId: id, category: "Homework", isTest: false, date, subject: "Math", content: "Page 1", teacher: "Teacher One", lessonNo: "1", start: "08:00", end: "08:45", ...extra },
    ...e,
  });

async function setup(events: (childIds: string[]) => NewJournalEvent[], twoChildren = false) {
  const server = createFakePostgrest(NOW, KEY);
  const config = exampleConfig();
  const [first] = config.children;
  if (twoChildren) config.children.push({ ...first!, id: "00000000-0000-4000-8000-0000000000c2", name: "Child Two" });
  if (twoChildren) config.accounts.push({ ...config.accounts[0]!, id: "00000000-0000-4000-8000-0000000000a2", child_id: "00000000-0000-4000-8000-0000000000c2" });
  server.seedConfig(config);
  const childIds = config.children.map((child) => child.id);
  const supabase = { url: SUPABASE, key: KEY, fetch: server.fetch, now: () => NOW };
  await createSupabaseStorage(supabase).appendEvents(events(childIds));
  const counting = countFetches(server.fetch);
  const storage = createSupabaseStorage({ ...supabase, fetch: counting.fetch });
  const runtime = { ...fakeRuntime({ now: NOW }), fetch: counting.fetch };
  return { deps: { runtime, storage, familyId: FAMILY_ID, counter: counting }, childIds };
}

const check = (childId: string, payload: Record<string, unknown>) =>
  event(childId, { stream: `check:librus-watch:${childId}`, kind: "check", eventType: "CheckCompleted", day: "2026-01-10", payload });

const itemEvent = (childId: string, kind: string, sourceId: string, date: string, text: string) =>
  event(childId, {
    stream: `item:${kind}:${sourceId}`, kind: kind as "dayOff", day: date, eventType: "ItemRecorded",
    payload: { scope: kind, sourceId, kind, childId, date, title: "Break", text },
  });

describe("storedLessonsExport days off", () => {
  it("cancels Lessons inside a day off and keeps the others", async () => {
    const { deps, childIds } = await setup(([c]) => [
      lessonEvent(c!, "2026-01-11", 1), lessonEvent(c!, "2026-01-12", 1), lessonEvent(c!, "2026-01-13", 2), lessonEvent(c!, "2026-01-14", 1),
      itemEvent(c!, "dayOff", "d1", "2026-01-12", "Break\n2026-01-12 - 2026-01-13"),
      itemEvent(c!, "terminarz", "t1", "2026-01-14", "dzień wolny"),
    ]);
    const result = await storedLessonsExport(deps, { childId: childIds[0], from: "2026-01-11", to: "2026-01-14" });
    expect(result.lessons.map((l) => [l.date, l.status, l.cancelled, l.cancelReason?.sourceId])).toEqual([
      ["2026-01-11", "normal", false, undefined], ["2026-01-12", "cancelled", true, "d1"],
      ["2026-01-13", "cancelled", true, "d1"], ["2026-01-14", "normal", false, undefined],
    ]);
    expect(result.lessons[1]!.cancelReason).toEqual({ reason: "day_off", sourceStream: "item:dayOff:d1", sourceId: "d1" });
    expect(result.fetches!.total).toBeLessThanOrEqual(4);
  });

  it("covers a day off that starts before the range", async () => {
    const { deps, childIds } = await setup(([c]) => [
      lessonEvent(c!, "2026-01-12", 1), itemEvent(c!, "dayOff", "d2", "2026-01-05", "Break\n2026-01-05 - 2026-01-12"),
    ]);
    const result = await storedLessonsExport(deps, { childId: childIds[0], from: "2026-01-12", to: "2026-01-14" });
    expect(result.lessons[0]).toMatchObject({ status: "cancelled", cancelled: true });
  });

  it("treats a day off without a range line as one day", async () => {
    const { deps, childIds } = await setup(([c]) => [
      lessonEvent(c!, "2026-01-12", 1), lessonEvent(c!, "2026-01-13", 1), itemEvent(c!, "dayOff", "d3", "2026-01-12", "Break"),
    ]);
    const result = await storedLessonsExport(deps, { childId: childIds[0], from: "2026-01-12", to: "2026-01-14" });
    expect(result.lessons.map((l) => l.cancelled)).toEqual([true, false]);
  });
});

describe("storedLessonsExport", () => {
  it("makes at most 4 Supabase fetches and no other fetch", async () => {
    const { deps, childIds } = await setup(([c]) => [lessonEvent(c!, "2026-01-10", 1)]);
    const result = await storedLessonsExport(deps, { childId: childIds[0] });
    expect(result.fetches!.total).toBeLessThanOrEqual(4);
    expect(Object.keys(result.fetches!.hosts)).toEqual(["project.example.test"]);
  });

  it("uses today and 13 days by default and orders lessons and homework", async () => {
    const { deps, childIds } = await setup(([c]) => [
      lessonEvent(c!, "2026-01-11", 2), lessonEvent(c!, "2026-01-10", 3), lessonEvent(c!, "2026-01-10", 1),
      lessonEvent(c!, "2026-01-09", 1), lessonEvent(c!, "2026-01-24", 1),
      homeworkEvent(c!, "b", "2026-01-10", { start: "09:00" }), homeworkEvent(c!, "a", "2026-01-10", { start: "08:00" }),
    ]);
    const result = await storedLessonsExport(deps, {});
    expect(result).toMatchObject({ childId: childIds[0], child: "Child One", from: "2026-01-10", to: "2026-01-23" });
    expect(result.lessons.map((l) => l.id.split(":").slice(1).join(":"))).toEqual(["2026-01-10:1", "2026-01-10:3", "2026-01-11:2"]);
    expect(result.lessons[0]).toMatchObject({ vanished: false, seq: 1, subject: "Math", status: "normal", stream: `lesson:${childIds[0]}:2026-01-10:1` });
    expect(result.homework.map((h) => h.id)).toEqual(["a", "b"]);
  });

  it("uses from and to", async () => {
    const { deps } = await setup(([c]) => [lessonEvent(c!, "2026-02-01", 1), lessonEvent(c!, "2026-02-03", 1), lessonEvent(c!, "2026-02-09", 1)]);
    const result = await storedLessonsExport(deps, { from: "2026-02-01", to: "2026-02-05" });
    expect(result.lessons.map((l) => l.date)).toEqual(["2026-02-01", "2026-02-03"]);
    expect((await storedLessonsExport(deps, { from: "2026-02-01" })).to).toBe("2026-02-14");
  });

  it("keeps the Children apart", async () => {
    const { deps, childIds } = await setup(([a, b]) => [
      lessonEvent(a!, "2026-01-10", 1), lessonEvent(b!, "2026-01-10", 1, { subject: "Art" }), homeworkEvent(b!, "x", "2026-01-10"),
      check(a!, { timetableOk: true, homeworkOk: true }),
    ], true);
    const one = await storedLessonsExport(deps, { childId: childIds[0] });
    expect(one.lessons.map((l) => l.subject)).toEqual(["Math"]);
    expect(one.homework).toEqual([]);
    expect(one.lastCheck).toEqual({ timetableOk: true, homeworkOk: true });
    const two = await storedLessonsExport(deps, { childId: childIds[1] });
    expect(two).toMatchObject({ child: "Child Two", lastSavedAt: null, lastCheck: null });
    expect(two.lessons.map((l) => l.subject)).toEqual(["Art"]);
    expect(two.homework).toHaveLength(1);
  });

  it("keeps vanished entries and leaves them out of the notes", async () => {
    const { deps } = await setup(([c]) => [
      lessonEvent(c!, "2026-01-10", 1), lessonEvent(c!, "2026-01-10", 1, {}, { seq: 2, eventType: "LessonVanished" }),
      lessonEvent(c!, "2026-01-10", 2),
      homeworkEvent(c!, "h1", "2026-01-10"), homeworkEvent(c!, "h1", "2026-01-10", {}, { seq: 2, eventType: "HomeworkVanished" }),
      homeworkEvent(c!, "h2", "2026-01-10", { content: "Page 2", lessonNo: "2" }),
      homeworkEvent(c!, "t1", "2026-01-11", { category: "Test", isTest: true, content: "Unit 1" }),
      lessonEvent(c!, "2026-01-11", 1),
    ]);
    const result = await storedLessonsExport(deps, {});
    const [first, second, third] = result.lessons;
    expect(first).toMatchObject({ vanished: true, seq: 2, homeworkGiven: [], testAtNextLesson: [] });
    expect(second!.vanished).toBe(false);
    expect(second!.homeworkGiven).toEqual([{ category: "Homework", content: "Page 2", teacher: "Teacher One" }]);
    expect(second!.testAtNextLesson).toEqual([{ date: "2026-01-11", period: 1, category: "Test", content: "Unit 1" }]);
    expect(third!.date).toBe("2026-01-11");
    expect(result.homework.map((h) => [h.id, h.vanished])).toEqual([["h1", true], ["h2", false], ["t1", false]]);
    expect(result.homework[2]).toMatchObject({ isTest: true, lessonNo: "1" });
  });

  it("gives lastSavedAt from the check head", async () => {
    const { deps } = await setup(([c]) => [
      check(c!, { timetableOk: true, homeworkOk: false }),
      check(c!, { timetableOk: false, homeworkOk: true }),
    ].map((e, i) => ({ ...e, seq: i + 1 })));
    const result = await storedLessonsExport(deps, {});
    expect(result.lastSavedAt).toBe(NOW.toISOString());
    expect(result.lastCheck).toEqual({ timetableOk: false, homeworkOk: true });
  });

  it("reports a failed check after a good one and keeps the stored data", async () => {
    const { deps } = await setup(([c]) => [
      lessonEvent(c!, "2026-01-10", 1),
      check(c!, { timetableOk: true, homeworkOk: true, lessons: 1, homework: 0 }),
      { ...check(c!, { timetableOk: false, homeworkOk: false, lessons: 0, homework: 0 }), seq: 2 },
    ]);
    const result = await storedLessonsExport(deps, {});
    expect(result.lastCheck).toEqual({ timetableOk: false, homeworkOk: false });
    expect(result.lessons.map((l) => l.vanished)).toEqual([false]);
  });

  it("gives null with no check event and no data", async () => {
    const { deps } = await setup(() => []);
    expect(await storedLessonsExport(deps, { childId: "00000000-0000-4000-8000-0000000000c1" })).toMatchObject({ lastSavedAt: null, lastCheck: null, lessons: [], homework: [] });
  });

  it.each([
    [{ days: 3 }, /Unknown input key/],
    [{ from: "tomorrow" }, /from must be a date/],
    [{ to: 5 }, /to must be a date/],
    [{ childId: 4 }, /childId must be a text/],
    [{ childId: "nobody" }, /Unknown child/],
    [{ from: "2026-02-05", to: "2026-02-01" }, /not be before/],
    [{ from: "2026-02-01", to: "2026-04-05" }, /at most 60 days/],
    [[], /Input must be an object/],
  ])("rejects the input %j", async (input, message) => {
    const { deps } = await setup(() => []);
    await expect(storedLessonsExport(deps, input)).rejects.toThrow(message);
  });

  it("gives the Journal child_id on each lesson and homework entry", async () => {
    const { deps, childIds } = await setup(([a, b]) => [
      lessonEvent(a!, "2026-01-10", 1), lessonEvent(b!, "2026-01-10", 1), homeworkEvent(a!, "x", "2026-01-10"), homeworkEvent(b!, "y", "2026-01-10"),
    ], true);
    for (const childId of childIds) {
      const result = await storedLessonsExport(deps, { childId });
      expect(result.childId).toBe(childId);
      expect(result.lessons.length).toBeGreaterThan(0);
      expect(result.homework.length).toBeGreaterThan(0);
      expect([...result.lessons, ...result.homework].every((entry) => entry.childId === childId)).toBe(true);
    }
  });
});
