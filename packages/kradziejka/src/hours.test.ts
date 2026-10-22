import { describe, expect, it } from "vitest";
import { hoursOpen, isOpen, parseHours } from "./hours.ts";

const wednesday = new Date("2026-01-07T10:00:00Z");
const saturday = new Date("2026-01-10T10:00:00Z");

describe("active hours", () => {
  it("parses always, a daily window, and a weekday window", () => {
    expect(parseHours(" always ")).toEqual({ kind: "always" });
    expect(parseHours("09:00-17:00")).toMatchObject({ fromDay: 1, toDay: 7, start: 9 * 60, end: 17 * 60 });
    expect(parseHours("1-5 09:00-17:00")).toMatchObject({ fromDay: 1, toDay: 5 });
  });

  it("rejects a bad range", () => {
    expect(() => parseHours("later")).toThrow("activeHours");
    expect(() => parseHours("6-1 09:00-17:00")).toThrow("weekday");
    expect(() => parseHours("1-5 25:00-17:00")).toThrow("HH:MM");
  });

  it("is open only inside the window, including overnight", () => {
    const days = parseHours("1-5 09:00-17:00");
    expect(isOpen(days, wednesday, "UTC")).toBe(true);
    expect(isOpen(days, new Date("2026-01-07T08:59:00Z"), "UTC")).toBe(false);
    expect(isOpen(days, new Date("2026-01-07T17:00:00Z"), "UTC")).toBe(false);
    expect(isOpen(days, saturday, "UTC")).toBe(false);
    expect(isOpen(parseHours("always"), saturday, "UTC")).toBe(true);
    const night = parseHours("22:00-06:00");
    expect(isOpen(night, new Date("2026-01-07T23:00:00Z"), "UTC")).toBe(true);
    expect(isOpen(night, new Date("2026-01-07T05:00:00Z"), "UTC")).toBe(true);
    expect(isOpen(night, new Date("2026-01-07T12:00:00Z"), "UTC")).toBe(false);
    expect(isOpen(parseHours("00:00-00:00"), wednesday, "UTC")).toBe(false);
  });

  it("treats a bad hours text as closed", () => {
    expect(hoursOpen("nope", wednesday, "UTC")).toBe(false);
    expect(hoursOpen("always", wednesday, "UTC")).toBe(true);
  });
});
