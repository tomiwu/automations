import { describe, expect, it } from "vitest";
import { CATALOGS, languageFor, t } from "./i18n.ts";

describe("catalogs", () => {
  it("have the same keys in pl and en", () => {
    expect(Object.keys(CATALOGS.pl).sort()).toEqual(Object.keys(CATALOGS.en).sort());
  });

  it("have no empty messages", () => {
    for (const catalog of Object.values(CATALOGS)) {
      for (const text of Object.values(catalog)) expect(text.trim()).not.toBe("");
    }
  });

  it("use the same placeholders in pl and en", () => {
    const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of Object.keys(CATALOGS.en) as (keyof typeof CATALOGS.en)[]) {
      expect(names(CATALOGS.pl[key])).toEqual(names(CATALOGS.en[key]));
    }
  });
});

describe("t", () => {
  it("returns the message in the requested language", () => {
    expect(t("en", "morning.title")).toBe(CATALOGS.en["morning.title"]);
    expect(t("pl", "morning.title")).toBe(CATALOGS.pl["morning.title"]);
  });

  it("replaces placeholders", () => {
    expect(t("en", "morning.heading", { child: "Child One", date: "2026-01-05" })).toBe(
      "Morning report for Child One, 2026-01-05",
    );
  });

  it("replaces every occurrence and accepts numbers", () => {
    expect(t("en", "afterschool.item", { time: "15:00", name: "Chess", place: "Room 1" })).toContain("15:00");
    expect(t("en", "grade.new", { child: "Child One", subject: "Math", value: 5 })).toContain("5");
  });

  it("keeps unknown placeholders visible", () => {
    expect(t("en", "morning.heading", { child: "Child One" })).toBe("Morning report for Child One, {date}");
  });
});

describe("languageFor", () => {
  it("maps supported codes, with or without a region", () => {
    expect(languageFor("pl")).toBe("pl");
    expect(languageFor("PL-pl")).toBe("pl");
    expect(languageFor("en-GB")).toBe("en");
  });

  it("falls back to en", () => {
    expect(languageFor("de")).toBe("en");
    expect(languageFor("")).toBe("en");
    expect(languageFor(null)).toBe("en");
    expect(languageFor(undefined)).toBe("en");
  });
});
