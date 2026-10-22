import { describe, expect, it } from "vitest";
import { clip, splitText } from "./clip.ts";

describe("clip", () => {
  it("keeps short text and cuts long text", () => {
    expect(clip("abc", 3)).toBe("abc");
    expect(clip("abcd", 3)).toBe("abc");
  });

  it("splits text at the limit", () => {
    expect(splitText("abc", 3)).toEqual(["abc"]);
    expect(splitText("abcdefg", 3)).toEqual(["abc", "def", "g"]);
    expect(splitText("x".repeat(3501))).toHaveLength(2);
  });
});
