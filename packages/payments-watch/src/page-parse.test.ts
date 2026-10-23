import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOrganizerAmount } from "./page-parse.ts";

const html = readFileSync(new URL("./fixtures/organizer-fees.html", import.meta.url), "utf8");

describe("parseOrganizerAmount", () => {
  it("reads the amount of a month in grosze", () => {
    expect(parseOrganizerAmount(html, "2025-01")).toBe(15000);
  });

  it("reads an amount with a space as thousands separator", () => {
    expect(parseOrganizerAmount(html, "2025-02")).toBe(125050);
  });

  it("gives nothing for a month that is not in the page", () => {
    expect(parseOrganizerAmount(html, "2025-04")).toBeUndefined();
  });

  it("gives nothing when the amount cell has no number", () => {
    expect(parseOrganizerAmount(html, "2025-03")).toBeUndefined();
  });

  it("reads an amount without decimals", () => {
    const page = '<table class="fees"><tr data-month="2025-05"><td class="amount">90 zł</td></tr></table>';
    expect(parseOrganizerAmount(page, "2025-05")).toBe(9000);
  });

  it("throws when the page has no fee table", () => {
    expect(() => parseOrganizerAmount("<p>Login</p>", "2025-01")).toThrow("fee table not found");
  });
});
