import { describe, expect, it } from "vitest";
import { buildRedactor, MASK, parseEnvValues, secretValuesFromEnv } from "./redact.ts";

describe("parseEnvValues", () => {
  it("reads values, skips comments, empty lines and quotes", () => {
    const text = "# note\n\nA_TOKEN=plain-value-1\nB=\"quoted value 2\"\nC='single 3'\n";
    expect(parseEnvValues(text)).toEqual(["plain-value-1", "quoted value 2", "single 3"]);
  });
});

describe("secretValuesFromEnv", () => {
  it("takes only secret-like names", () => {
    const env = { A_TOKEN: "one", B_KEY: "two", C_SECRET: "three", PATH: "/bin", D_TOKEN: undefined };
    expect(secretValuesFromEnv(env)).toEqual(["one", "two", "three", ""]);
  });
});

describe("buildRedactor", () => {
  it("masks known values, longest first", () => {
    const redact = buildRedactor(["abcd1234", "abcd1234-long"]);
    expect(redact("x abcd1234-long y abcd1234")).toBe(`x ${MASK} y ${MASK}`);
  });

  it("ignores empty and very short values", () => {
    const redact = buildRedactor(["", "ab"]);
    expect(redact("ab cd")).toBe("ab cd");
  });

  it("masks special characters in a value", () => {
    expect(buildRedactor(["a.b*c+d"])("v=a.b*c+d")).toBe(`v=${MASK}`);
  });

  it.each([
    ["sk-ant-FAKE0123_abc-def"],
    ["ghp_FAKE0123456789"],
    ["gho_FAKE0123456789"],
    ["ghs_FAKE0123456789"],
    ["github_pat_FAKE0123_456789"],
  ])("masks the token pattern %s", (token) => {
    expect(buildRedactor([])(`before ${token} after`)).toBe(`before ${MASK} after`);
  });

  it("masks the value of NAME_TOKEN= and NAME_KEY= and keeps the name", () => {
    const redact = buildRedactor([]);
    expect(redact("-e CURSOR_API_KEY=fake-key-1 -e X_TOKEN=\"fake token 2\"")).toBe(
      `-e CURSOR_API_KEY=${MASK} -e X_TOKEN=${MASK}`,
    );
  });
});
