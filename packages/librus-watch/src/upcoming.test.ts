import { describe, expect, it } from "vitest";
import { readLessons } from "./lessons.ts";
import { matchLesson, upcoming } from "./upcoming.ts";
import { CHILD1, fakeSource, lesson } from "./test-fixtures.ts";
import type { HomeworkItem } from "./types.ts";

const child = { id: CHILD1, name: "Child One" };
const entry = (id: string, date: string, subject: string, category = "Homework"): HomeworkItem => ({
  id,
  hash: "h",
  category,
  date,
  content: `Content ${id}`,
  subject,
  teacher: "Teacher One",
});

describe("upcoming", () => {
  it("places an entry on the first not-cancelled Lesson of its subject", () => {
    const lessons = [lesson("2026-01-09", 1, "Math", { status: "cancelled" }), lesson("2026-01-09", 3, " math "), lesson("2026-01-09", 2, "MATH")];
    expect(matchLesson(entry("1", "2026-01-09", "Math"), lessons)?.period).toBe(2);
    expect(matchLesson(entry("1", "2026-01-09", ""), lessons)).toBeUndefined();
  });

  it("lists entries in the range with the childId and the name, in order", async () => {
    const source = fakeSource();
    source.items.homework = [entry("2", "2026-01-12", "Art"), entry("1", "2026-01-09", "Math"), entry("3", "2026-03-01", "Math")];
    source.lessons = [lesson("2026-01-09", 2, "Math")];
    const result = await upcoming(source, { child, from: "2026-01-08", days: 10 });
    expect(result).toMatchObject({ childId: CHILD1, child: "Child One", from: "2026-01-08", to: "2026-01-18", timetableOk: true });
    expect(result.entries.map((e) => [e.id, e.childId, e.child, e.lessonNo, e.start, e.end])).toEqual([
      ["1", CHILD1, "Child One", "2", "09:00", "09:45"],
      ["2", CHILD1, "Child One", null, null, null],
    ]);
  });

  it("marks the timetable as not available", async () => {
    const source = fakeSource();
    source.timetableError = "down";
    expect((await upcoming(source, { child, from: "2026-01-08", days: 1 })).timetableOk).toBe(false);
  });
});

describe("readLessons", () => {
  const source = () => {
    const s = fakeSource();
    s.lessons = [lesson("2026-01-12", 1, "Math"), lesson("2026-01-09", 2, "Math"), lesson("2026-01-09", 1, "Art", { status: "cancelled" })];
    return s;
  };

  it("adds the homework given and the test at the next Lesson", async () => {
    const s = source();
    s.items.homework = [entry("1", "2026-01-09", "Math"), entry("2", "2026-01-12", "Math", "Sprawdzian")];
    const { lessons, error } = await readLessons(s, child);
    expect(error).toBeUndefined();
    expect(lessons.map((l) => l.id)).toEqual([`${CHILD1}:2026-01-09:1`, `${CHILD1}:2026-01-09:2`, `${CHILD1}:2026-01-12:1`]);
    expect(lessons[0]).toMatchObject({ childId: CHILD1, child: "Child One", status: "cancelled" });
    expect(lessons[1]?.homeworkGiven).toEqual([{ category: "Homework", content: "Content 1", teacher: "Teacher One" }]);
    expect(lessons[1]?.testAtNextLesson).toEqual([{ date: "2026-01-12", period: 1, category: "Sprawdzian", content: "Content 2" }]);
    expect(lessons[2]?.homeworkGiven).toEqual([]);
    expect(lessons[2]?.testAtNextLesson).toEqual([]);
  });

  it("gives an empty result with the reason when there is no timetable", async () => {
    const s = fakeSource();
    expect(await readLessons(s, child)).toEqual({ lessons: [] });
    s.timetableError = "down";
    expect(await readLessons(s, child)).toEqual({ lessons: [], error: "down" });
  });
});
