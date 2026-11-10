import { describe, expect, it } from "vitest";
import { DAY_OFF_STREAM, evaluateDaysOff, mask, sourceStreams, unwrap, type CheckLesson, type DaysOffInput } from "./days-off-check.ts";

const CHILD = "00000000-0000-4000-8000-0000000000c1";
const SCHOOL = `item:schoolFreeDays:${CHILD}:701`;
const OPTIONS = { from: "2026-11-12", to: "2026-11-13", expectLessons: 10 };

const lesson = (date: string, period: number, dayOff = true): CheckLesson => ({
  date, period, status: dayOff ? "cancelled" : "scheduled", cancelled: dayOff, vanished: false,
  ...(dayOff ? { cancelReason: { reason: "day_off", sourceStream: SCHOOL, sourceId: "701" } } : {}),
});

const tenLessons = (): CheckLesson[] => [1, 2, 3, 4, 5].flatMap((p) => [lesson("2026-11-12", p), lesson("2026-11-13", p)]);

const good = (): DaysOffInput => ({
  lastSavedAt: "2026-11-11T04:30:00.000Z",
  lessons: [...tenLessons(), lesson("2026-11-14", 1, false)],
  histories: [{ stream: SCHOOL, events: [{ kind: "dayOff", eventType: "ItemSeen", day: "2026-11-12" }] }],
});

describe("evaluateDaysOff", () => {
  it("is green when 10 Lessons are cancelled as day_off and the Journal has the dayOff Item", () => {
    const result = evaluateDaysOff(good(), OPTIONS);
    expect(result.ok).toBe(true);
    expect(result.lines[1]).toBe("OK lessons: 10 of 10 in 2026-11-12..2026-11-13 cancelled as day_off (expected at least 10)");
  });

  it("is red before the first Journal pass", () => {
    expect(evaluateDaysOff({ ...good(), lastSavedAt: null }, OPTIONS).ok).toBe(false);
  });

  it("is red and names the Lesson that is not cancelled", () => {
    const input = good();
    input.lessons[0] = lesson("2026-11-12", 1, false);
    const result = evaluateDaysOff(input, OPTIONS);
    expect(result.ok).toBe(false);
    expect(result.lines).toContain("FAIL lessons not cancelled as day_off: 2026-11-12#1");
  });

  it("is red with fewer Lessons than expected", () => {
    expect(evaluateDaysOff({ ...good(), lessons: tenLessons().slice(0, 8) }, OPTIONS).ok).toBe(false);
  });

  it("is red when the source stream has no dayOff event in the Journal", () => {
    const result = evaluateDaysOff({ ...good(), histories: [{ stream: SCHOOL, events: [] }] }, OPTIONS);
    expect(result.ok).toBe(false);
    expect(result.lines.at(-1)).toBe("FAIL journal item:schoolFreeDays:00000000…:701: 0 dayOff event(s)");
  });

  it("is red when no Lesson has a day-off source", () => {
    const input = { ...good(), lessons: [lesson("2026-11-12", 1, false)], histories: [] };
    expect(evaluateDaysOff(input, { ...OPTIONS, expectLessons: 0 }).lines.at(-1)).toBe("FAIL journal: no day-off source stream in the Lessons");
  });

  it("is red for a stream name that is not a producer day-off stream", () => {
    const bad = "item:dayOff:701";
    const input = { ...good(), lessons: good().lessons.map((l) => (l.cancelReason ? { ...l, cancelReason: { ...l.cancelReason, sourceStream: bad } } : l)), histories: [{ stream: bad, events: [{ kind: "dayOff", eventType: "ItemSeen", day: null }] }] };
    const result = evaluateDaysOff(input, OPTIONS);
    expect(result.ok).toBe(false);
    expect(result.lines.at(-1)).toContain("not an item:schoolFreeDays|classFreeDays stream");
  });

  it("ignores vanished Lessons", () => {
    const input = good();
    input.lessons.push({ ...lesson("2026-11-12", 9, false), vanished: true });
    expect(evaluateDaysOff(input, OPTIONS).ok).toBe(true);
  });

  it("never prints a full Child ID", () => {
    const text = evaluateDaysOff(good(), OPTIONS).lines.join("\n");
    expect(text).not.toContain(CHILD);
  });
});

describe("helpers", () => {
  it("matches both producer day-off streams only", () => {
    expect(DAY_OFF_STREAM.test(SCHOOL)).toBe(true);
    expect(DAY_OFF_STREAM.test(`item:classFreeDays:${CHILD}:9`)).toBe(true);
    expect(DAY_OFF_STREAM.test("item:dayOff:9")).toBe(false);
  });

  it("lists each source stream one time", () => {
    expect(sourceStreams(tenLessons())).toEqual([SCHOOL]);
  });

  it("masks IDs and unwraps a wrapped CLI answer", () => {
    expect(mask(`x ${CHILD} y`)).toBe("x 00000000… y");
    expect(unwrap<{ lessons: unknown[] }>({ ok: true, result: { data: { lessons: [] } } }, "lessons")).toEqual({ lessons: [] });
    expect(unwrap({ a: 1 }, "lessons")).toBeUndefined();
    expect(unwrap(null, "lessons")).toBeUndefined();
  });
});
