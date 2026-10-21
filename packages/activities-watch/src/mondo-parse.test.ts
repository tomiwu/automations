import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isoDate, parseMondoEvents } from "./mondo-parse.ts";

const page = readFileSync(new URL("./fixtures/mondo-activity.html", import.meta.url), "utf8");
const PLACE = "Example Hall MON 13:00-13:30";

describe("parseMondoEvents", () => {
  it("reads each class once, ordered by start", () => {
    expect(parseMondoEvents(page)).toEqual([
      { start: "2026-10-19T13:00", end: "2026-10-19T13:30", place: PLACE, status: "planned" },
      { start: "2026-10-26T13:00", end: "2026-10-26T13:30", place: PLACE, status: "planned" },
      { start: "2026-11-02T13:00", end: "2026-11-02T13:30", place: PLACE, status: "cancelled" },
      { start: "2027-01-04T09:00", end: "2027-01-04T09:30", place: PLACE, status: "planned" },
    ]);
  });

  it("maps the moved badge", () => {
    const events = parseMondoEvents(page.replace("Odwołane", "Przeniesione"));
    expect(events.find((e) => e.start.startsWith("2026-11-02"))?.status).toBe("moved");
  });

  it("skips a class without a date or a time", () => {
    expect(parseMondoEvents(page.replace("4 sty 2027", "wkrótce"))).toHaveLength(3);
    expect(parseMondoEvents(page.replace("9:00 - 9:30", "later"))).toHaveLength(3);
  });

  it("reports a page without a class list as a changed site", () => {
    expect(() => parseMondoEvents("<p>Nothing</p>")).toThrow(/Mondo: class list not found/);
  });
});

describe("isoDate", () => {
  it("maps Polish month abbreviations", () => {
    expect(["5 sty 2027", "28 gru 2026", "1 maj 2027", "soon", "1 xyz 2026"].map(isoDate)).toEqual([
      "2027-01-05",
      "2026-12-28",
      "2027-05-01",
      undefined,
      undefined,
    ]);
  });
});
