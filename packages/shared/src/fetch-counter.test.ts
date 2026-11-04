import { describe, expect, it } from "vitest";
import { countFetches, formatFetchCount } from "./fetch-counter.ts";

describe("countFetches", () => {
  it("counts the calls for each host, also the failed ones", async () => {
    const counter = countFetches(async (input) => {
      if (input.includes("bad")) throw new Error("down");
      return new Response("");
    });
    await counter.fetch("https://a.example.org/x");
    await counter.fetch("https://a.example.org/y");
    await counter.fetch("https://b.example.org/");
    await expect(counter.fetch("https://bad.example.org/")).rejects.toThrow("down");
    await counter.fetch("not a url");
    expect(counter.count()).toEqual({
      total: 5,
      hosts: { "a.example.org": 2, "b.example.org": 1, "bad.example.org": 1, unknown: 1 },
    });
  });

  it("starts at zero and returns a copy", () => {
    const counter = countFetches(async () => new Response(""));
    const first = counter.count();
    expect(first).toEqual({ total: 0, hosts: {} });
    first.hosts.x = 1;
    expect(counter.count().hosts).toEqual({});
  });
});

describe("formatFetchCount", () => {
  it("lists the total and the sorted hosts", () => {
    expect(formatFetchCount({ total: 3, hosts: { "b.org": 1, "a.org": 2 } })).toBe("fetches total=3 a.org=2 b.org=1");
    expect(formatFetchCount({ total: 0, hosts: {} })).toBe("fetches total=0");
  });
});
