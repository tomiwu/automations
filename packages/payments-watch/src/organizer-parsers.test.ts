import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { organizerTypeOf, parseFeePage } from "./organizer-parsers.ts";

const load = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const cases = [
  { type: "activenow", file: "activenow-fees.html", jan: 18000, feb: 120050, empty: "<p>Login</p>" },
  { type: "edusky", file: "edusky-fees.html", jan: 21000, feb: 110000, empty: "<p>Login</p>" },
  { type: "mondo", file: "mondo-fees.html", jan: 9550, feb: 100000, empty: "<p>Login</p>" },
  { type: "plain", file: "organizer-fees.html", jan: 15000, feb: 125050, empty: "<p>Login</p>" },
] as const;

describe.each(cases)("parseFeePage $type", ({ type, file, jan, feb, empty }) => {
  const html = load(file);

  it("reads the amount of a month in grosze", () => {
    expect(parseFeePage(type, html, "2025-01")).toBe(jan);
  });

  it("reads an amount with a space as thousands separator", () => {
    expect(parseFeePage(type, html, "2025-02")).toBe(feb);
  });

  it("gives nothing for a month with no number", () => {
    expect(parseFeePage(type, html, "2025-03")).toBeUndefined();
  });

  it("gives nothing for a month that is not in the page", () => {
    expect(parseFeePage(type, html, "2030-07")).toBeUndefined();
  });

  it("throws when the page has no fee list", () => {
    expect(() => parseFeePage(type, empty, "2025-01")).toThrow("fee list not found");
  });
});

describe("organizerTypeOf", () => {
  it.each([
    ["https://school.activenow.example.com/fees", "activenow"],
    ["https://school.edusky.example.com/fees", "edusky"],
    ["https://school.mondo.example.com/fees", "mondo"],
    ["https://organizer.example.com/fees", "plain"],
    ["not a url", "plain"],
  ])("%s is %s", (url, type) => {
    expect(organizerTypeOf(url)).toBe(type);
  });
});
