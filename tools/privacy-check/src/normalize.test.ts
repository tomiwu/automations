import { describe, expect, it } from "vitest";
import { normalize, phrases, tokens } from "./normalize.ts";

describe("normalize", () => {
  it("makes lower case and removes Polish diacritics", () => {
    expect(normalize("ZAŻÓŁĆ Gęślą Jaźń")).toBe("zazolc gesla jazn");
  });

  it("splits camel case words", () => {
    expect(normalize("childOneLogin")).toBe("child one login");
  });
});

describe("tokens", () => {
  it("splits on every character that is not a letter or a digit", () => {
    expect(tokens("CHILD_ONE-login: śnieg.txt")).toEqual(["child", "one", "login", "snieg", "txt"]);
  });

  it("drops short tokens and tokens without a letter", () => {
    expect(tokens("an ox 12345 abc a1b")).toEqual(["abc", "a1b"]);
  });
});

describe("phrases", () => {
  it("gives every sequence of 1 to maxWords tokens", () => {
    expect(phrases(["one", "two", "three"], 2)).toEqual(["one", "one two", "two", "two three", "three"]);
  });
});
