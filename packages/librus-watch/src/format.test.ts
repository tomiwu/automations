import { describe, expect, it } from "vitest";
import { formatDayOffLine, formatMeetingLine } from "./format.ts";

describe("morning-report lines", () => {
  const meeting = { id: "m1", hash: "h", date: "2026-02-03", start: "17:00", end: "17:30", topic: "Open day", room: "5", teacher: "Teacher One" };

  it("formats a meeting with time, room and teacher", () => {
    expect(formatMeetingLine("en", meeting)).toBe("Parent meeting 2026-02-03 17:00-17:30: Open day (5, Teacher One)");
  });

  it("formats a meeting without end time, room and teacher", () => {
    expect(formatMeetingLine("en", { ...meeting, end: "", room: "", teacher: "" })).toBe("Parent meeting 2026-02-03 17:00: Open day");
    expect(formatMeetingLine("pl", { ...meeting, start: "", end: "", room: "", teacher: "" })).toBe("Zebranie z rodzicami 2026-02-03: Open day");
  });

  it("formats a day off as a range or one day", () => {
    const dayOff = { id: "d1", hash: "h", from: "2026-02-10", to: "2026-02-14", name: "Break" };
    expect(formatDayOffLine("en", dayOff)).toBe("Day off 2026-02-10 - 2026-02-14: Break");
    expect(formatDayOffLine("pl", { ...dayOff, to: dayOff.from })).toBe("Dzień wolny 2026-02-10: Break");
  });
});
