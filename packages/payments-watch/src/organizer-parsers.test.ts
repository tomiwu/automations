import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { organizerTypeOf, parseFeePage, readFeePage } from "./organizer-parsers.ts";

const load = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const cases = [
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

describe.each(cases)("readFeePage $type", ({ type, file, jan }) => {
  const html = load(file);
  const cancelled = load(file.replace(".html", "-cancelled.html"));

  it("reads a listed charge with its amount", () => {
    expect(readFeePage(type, html, "2025-01")).toEqual({ state: "listed", amount: jan });
  });

  it("reads a listed charge with no number as listed without an amount", () => {
    expect(readFeePage(type, html, "2025-03")).toEqual({ state: "listed" });
  });

  it("reads a charge that is not in a page with other charges as absent", () => {
    expect(readFeePage(type, html, "2030-07")).toEqual({ state: "absent" });
  });

  it("reads a charge that is marked cancelled as cancelled, with no amount", () => {
    expect(readFeePage(type, cancelled, "2025-02")).toEqual({ state: "cancelled" });
    expect(readFeePage(type, cancelled, "2025-01")).toEqual({ state: "listed", amount: jan });
    expect(parseFeePage(type, cancelled, "2025-02")).toBeUndefined();
  });

  it("reads a page that shows the Child as not enrolled as withdrawn", () => {
    const withdrawn = html.replace("</body>", '<p data-enrolled="false">Not enrolled</p></body>');
    expect(readFeePage(type, withdrawn, "2025-01")).toEqual({ state: "withdrawn" });
  });

  it("reads a fee list with no charge as empty, not as absent", () => {
    const list = { edusky: '<table class="edusky-charges"></table>', mondo: '<ul class="mondo-fees"></ul>', plain: '<table class="fees"></table>' };
    expect(readFeePage(type, list[type], "2025-01")).toEqual({ state: "empty" });
  });

  it("throws when the page has no fee list", () => {
    expect(() => readFeePage(type, "<p>Login</p>", "2025-01")).toThrow("fee list not found");
  });
});

describe("organizerTypeOf", () => {
  it.each([
    ["https://school.activenow.example.com/fees", "plain"],
    ["https://school.edusky.example.com/fees", "edusky"],
    ["https://school.mondo.example.com/fees", "mondo"],
    ["https://organizer.example.com/fees", "plain"],
    ["not a url", "plain"],
  ])("%s is %s", (url, type) => {
    expect(organizerTypeOf(url)).toBe(type);
  });
});
