import { describe, expect, it } from "vitest";
import { parseAllowlist, senderAllowed } from "./allowlist.ts";

describe("allowlist", () => {
  it("parses a comma-separated list and an array", () => {
    expect(parseAllowlist("1000001, 1000002,1000001")).toEqual(["1000001", "1000002"]);
    expect(parseAllowlist(["1000002"])).toEqual(["1000002"]);
    expect(parseAllowlist("")).toEqual([]);
    expect(parseAllowlist([])).toEqual([]);
  });

  it("rejects names, a non-list, and a list that is too long", () => {
    expect(() => parseAllowlist("abc")).toThrow("digits");
    expect(() => parseAllowlist(1)).toThrow("list");
    expect(() => parseAllowlist(Array.from({ length: 21 }, (_, index) => String(index + 1)))).toThrow("20");
  });

  it("accepts only a private chat from an allowlisted id", () => {
    const allowlist = ["1000001"];
    expect(senderAllowed(allowlist, { senderId: "1000001", chatType: "private" })).toBe(true);
    expect(senderAllowed(allowlist, { senderId: "1000002", chatType: "private" })).toBe(false);
    expect(senderAllowed(allowlist, { senderId: "1000001", chatType: "group" })).toBe(false);
    expect(senderAllowed([], { senderId: "1000001", chatType: "private" })).toBe(false);
  });
});
