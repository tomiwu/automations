import { describe, expect, it } from "vitest";
import { asRecord, numberField, readActive, textField } from "./input.ts";

describe("input helpers", () => {
  it("reads records, numbers, text, and booleans", () => {
    expect(asRecord(null)).toBeNull();
    expect(asRecord([])).toBeNull();
    expect(numberField({ n: 1 }, "n")).toBe(1);
    expect(numberField({ n: "1" }, "n")).toBeNull();
    expect(textField({ t: " " }, "t")).toBeNull();
    expect(readActive(undefined, true)).toBe(true);
    expect(readActive("on", false)).toBe(true);
    expect(readActive("off", true)).toBe(false);
    expect(readActive(false, true)).toBe(false);
    expect(() => readActive("yes", false)).toThrow("active");
  });
});
