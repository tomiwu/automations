import { describe, expect, it } from "vitest";
import { readCalendar } from "./calendar.ts";
import { fakeSource, lesson } from "./test-fixtures.ts";
import type { HomeworkItem } from "./types.ts";

const child = { id: "kid", name: "Child One" };
const test = (date: string, extra: Partial<HomeworkItem> = {}): HomeworkItem => ({
  id: "1",
  hash: "a",
  category: "Test",
  date,
  content: "Unit 3",
  subject: "Math",
  teacher: "Teacher One",
  ...extra,
});

describe("readCalendar", () => {
  it("returns lessons and upcoming entries for 14 days", async () => {
    const source = fakeSource();
    source.lessons = [lesson("2026-01-07", 1, "Math"), lesson("2026-01-08", 2, "Math")];
    source.items.homework = [test("2026-01-08"), test("2026-01-20", { id: "2" }), test("2026-01-06", { id: "3" })];
    const result = await readCalendar(source, child, "2026-01-07");
    expect(result).toMatchObject({ from: "2026-01-07", to: "2026-01-20", timetableOk: true });
    expect(result.entries.map((e) => e.id)).toEqual(["1", "2"]);
    expect(result.entries[0]).toMatchObject({ lessonNo: "2", start: "09:00" });
    expect(result.lessons[0]?.testAtNextLesson).toHaveLength(1);
  });

  it("reads the timetable once and the homework once", async () => {
    const source = fakeSource();
    let timetables = 0;
    let homeworks = 0;
    const { timetable, currentItems } = source;
    source.timetable = (from, to) => (timetables++, timetable(from, to));
    source.currentItems = ((watcher: never, since?: string) => (homeworks++, currentItems(watcher, since))) as never;
    await readCalendar(source, child, "2026-01-07");
    expect([timetables, homeworks]).toEqual([1, 1]);
  });

  it("returns the error and skips the homework when Librus gave no timetable", async () => {
    const source = fakeSource();
    source.timetableError = "Librus: down";
    let homeworks = 0;
    source.currentItems = (async () => (homeworks++, [])) as never;
    const result = await readCalendar(source, child, "2026-01-07");
    expect(result).toEqual({ from: "2026-01-07", to: "2026-01-20", timetableOk: false, lessons: [], entries: [], error: "Librus: down" });
    expect(homeworks).toBe(0);
  });
});
