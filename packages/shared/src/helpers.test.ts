import { describe, expect, it } from "vitest";
import {
  activitiesOn,
  addDays,
  createHttpSession,
  hasNoInput,
  localDate,
  localTime,
  nextOccurrence,
  parseTime,
  runsOn,
  weekdayOf,
  zonedParts,
} from "./index.ts";

describe("hasNoInput", () => {
  it("is true for empty values", () => {
    for (const value of [undefined, null, "", "  ", [], {}]) expect(hasNoInput(value)).toBe(true);
  });
  it("is false for values with content", () => {
    for (const value of ["a", [1], { a: 1 }, 0, false]) expect(hasNoInput(value)).toBe(false);
  });
});

describe("time helpers", () => {
  const instant = new Date("2025-01-05T23:30:00Z");
  it("uses the time zone for the local date, time and weekday", () => {
    expect(localDate(instant, "Europe/Warsaw")).toBe("2025-01-06");
    expect(localTime(instant, "Europe/Warsaw")).toBe("00:30");
    expect(localDate(instant, "UTC")).toBe("2025-01-05");
    expect(zonedParts(instant, "Europe/Warsaw")).toMatchObject({ weekday: 1, hour: 0, minute: 30 });
    expect(zonedParts(instant, "UTC").weekday).toBe(7);
  });
  it("adds days across a month end", () => {
    expect(addDays("2025-01-31", 1)).toBe("2025-02-01");
    expect(addDays("2025-03-01", -1)).toBe("2025-02-28");
    expect(() => addDays("bad", 1)).toThrow("Bad date");
  });
  it("returns the weekday of a date", () => {
    expect(weekdayOf("2025-01-06")).toBe(1);
    expect(weekdayOf("2025-01-12")).toBe(7);
  });
});

describe("schedule helpers", () => {
  const classes = [
    { weekday: 2, start_time: "16:00", enabled: true },
    { weekday: 2, start_time: "14:30", enabled: true },
    { weekday: 2, start_time: "10:00", enabled: false },
    { weekday: 3, start_time: "09:00", enabled: true },
  ];
  it("parses a time and rejects a bad time", () => {
    expect(parseTime("07:05")).toBe(425);
    expect(() => parseTime("24:00")).toThrow("Bad time");
  });
  it("checks the weekday and the enabled flag", () => {
    expect(runsOn(classes[0]!, 2)).toBe(true);
    expect(runsOn(classes[0]!, 3)).toBe(false);
    expect(runsOn(classes[2]!, 2)).toBe(false);
  });
  it("lists the Activities of a date by start time", () => {
    expect(activitiesOn(classes, "2025-01-07").map((a) => a.start_time)).toEqual(["14:30", "16:00"]);
  });
  it("finds the next occurrence", () => {
    const activity = { weekday: 2, start_time: "16:00" };
    expect(nextOccurrence(activity, new Date("2025-01-07T10:00:00Z"), "UTC")).toBe("2025-01-07");
    expect(nextOccurrence(activity, new Date("2025-01-07T16:00:00Z"), "UTC")).toBe("2025-01-14");
    expect(nextOccurrence(activity, new Date("2025-01-08T10:00:00Z"), "UTC")).toBe("2025-01-14");
  });
});

describe("createHttpSession", () => {
  it("stores cookies, sends them back and follows redirects", async () => {
    const seen: { url: string; cookie: string | null; method?: string }[] = [];
    const base = async (url: string, init?: RequestInit): Promise<Response> => {
      seen.push({ url, cookie: new Headers(init?.headers).get("cookie"), method: init?.method });
      if (url.endsWith("/login")) {
        const headers = new Headers({ location: "/home" });
        headers.append("set-cookie", "sid=abc; Path=/; HttpOnly");
        headers.append("set-cookie", "theme=dark");
        return new Response(null, { status: 302, headers });
      }
      return new Response("ok");
    };
    const session = createHttpSession(base);
    const response = await session.fetch("https://example.test/login", { method: "POST", body: "x" });
    expect(await response.text()).toBe("ok");
    expect(seen[1]).toEqual({ url: "https://example.test/home", cookie: "sid=abc; theme=dark", method: "GET" });
    expect(session.cookieHeader("https://example.test/other")).toBe("sid=abc; theme=dark");
    expect(session.cookieHeader("https://other.test/")).toBe("");
  });

  it("keeps the method on a 307 redirect and removes an expired cookie", async () => {
    let calls = 0;
    const base = async (url: string, init?: RequestInit): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        const headers = new Headers({ location: "https://example.test/b" });
        headers.append("set-cookie", "sid=abc");
        return new Response(null, { status: 307, headers });
      }
      expect(init?.method).toBe("POST");
      const headers = new Headers();
      headers.append("set-cookie", "sid=; Max-Age=0");
      headers.append("set-cookie", "=broken");
      return new Response("done", { headers });
    };
    const session = createHttpSession(base);
    await session.fetch("https://example.test/a", { method: "POST" });
    expect(session.cookieHeader("https://example.test/")).toBe("");
  });

  it("stops after too many redirects", async () => {
    const base = async () => new Response(null, { status: 302, headers: { location: "/loop" } });
    await expect(createHttpSession(base).fetch("https://example.test/loop")).rejects.toThrow("Too many redirects");
  });
});
