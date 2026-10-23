import { describe, expect, it } from "vitest";
import { isValidNip, isValidNrb } from "./checksums.ts";

describe("isValidNrb", () => {
  it("accepts a correct number", () => expect(isValidNrb("61109010140000071219812874")).toBe(true));
  it("rejects a wrong checksum", () => expect(isValidNrb("61109010140000071219812875")).toBe(false));
  it("rejects a wrong length", () => expect(isValidNrb("6110901014")).toBe(false));
});

describe("isValidNip", () => {
  it("accepts a correct number", () => expect(isValidNip("5260001246")).toBe(true));
  it("rejects a wrong checksum", () => expect(isValidNip("5260001247")).toBe(false));
  it("rejects a wrong length", () => expect(isValidNip("52600012")).toBe(false));
});
