import { describe, expect, it } from "vitest";
import { buildDenylist, denylistHit, hashPhrase, parseDenylist } from "./denylist.ts";

const plain = "# comment\nZorka\n\nBorzym Żółty Dom\n";

describe("buildDenylist", () => {
  it("stores only the salt, the longest phrase length and sorted hashes", () => {
    const list = buildDenylist(plain, "salt-1", "");
    expect(list.salt).toBe("salt-1");
    expect(list.maxWords).toBe(3);
    expect(list.peppered).toBe(false);
    expect(list.hashes).toEqual([...list.hashes].sort());
    expect(list.hashes).toContain(hashPhrase("salt-1", "", "zorka"));
    expect(list.hashes).toContain(hashPhrase("salt-1", "", "zorce"));
    expect(list.hashes).toContain(hashPhrase("salt-1", "", "borzym zolty dom"));
    expect(JSON.stringify(list)).not.toMatch(/zork|borzym/i);
  });

  it("gives other hashes with another salt or pepper", () => {
    expect(hashPhrase("salt-1", "", "zorka")).not.toBe(hashPhrase("salt-2", "", "zorka"));
    expect(hashPhrase("salt-1", "", "zorka")).not.toBe(hashPhrase("salt-1", "pepper", "zorka"));
    expect(buildDenylist(plain, "salt-1", "pepper").peppered).toBe(true);
  });

  it("gives an empty list for an empty file", () => {
    expect(buildDenylist("\n# only a comment\n", "s", "")).toEqual({ version: 1, salt: "s", peppered: false, maxWords: 1, hashes: [] });
  });
});

describe("denylistHit", () => {
  const matcher = denylistHit(buildDenylist(plain, "salt-1", ""), "");

  it("finds a private word in every written form", () => {
    expect(matcher("the login of ZORKA is set")).toBe(true);
    expect(matcher("const zorkaLogin = 1")).toBe(true);
    expect(matcher("list do Zorki")).toBe(true);
    expect(matcher("ZORKĄ")).toBe(true);
  });

  it("finds a phrase of more than one word", () => {
    expect(matcher("near borzym-zolty_dom today")).toBe(true);
    expect(matcher("borzym and a zolty dom")).toBe(false);
  });

  it("does not find other words", () => {
    expect(matcher("Child One goes to Example School")).toBe(false);
    expect(matcher("zorkaster")).toBe(false);
  });

  it("finds nothing with an empty list", () => {
    expect(denylistHit(buildDenylist("", "s", ""), "")("zorka")).toBe(false);
  });
});

describe("parseDenylist", () => {
  it("reads the JSON file text", () => {
    const list = buildDenylist(plain, "salt-1", "");
    expect(parseDenylist(JSON.stringify(list))).toEqual(list);
  });

  it("gives an empty list when there is no file", () => {
    expect(parseDenylist(undefined).hashes).toEqual([]);
  });
});
