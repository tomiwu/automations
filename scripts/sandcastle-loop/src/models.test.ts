import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ModelSpec } from "./config.ts";
import { DEFAULT_LIMIT_WAIT_MS, isLimitError, ModelOrder, parseResetTime, waitForReset, withFallback } from "./models.ts";

const claude: ModelSpec = { provider: "claude", model: "claude-sonnet-5-5" };
const composer: ModelSpec = { provider: "cursor", model: "composer-2.5" };
const grok: ModelSpec = { provider: "cursor", model: "grok-example" };
const NOW = new Date(2026, 10, 10, 1, 0, 0);

describe("withFallback", () => {
  it("returns the result of the first model", async () => {
    const order = new ModelOrder([claude, composer]);
    expect(await withFallback(order, async (m) => m.model)).toBe("claude-sonnet-5-5");
  });

  it("re-runs the phase on Composer 2.5 after a Claude limit, then on Grok after a second limit", async () => {
    const order = new ModelOrder([claude, composer, grok]);
    const logs: string[] = [];
    const tried: string[] = [];
    const fakeAgent = async (m: ModelSpec) => {
      tried.push(m.model);
      if (m === claude) throw new Error("Claude AI usage limit: You've hit your limit · resets 4:30am");
      if (m === composer) throw new Error("You are out of fast requests");
      return "done";
    };
    expect(await withFallback(order, fakeAgent, { log: (s) => logs.push(s) })).toBe("done");
    expect(tried).toEqual(["claude-sonnet-5-5", "composer-2.5", "grok-example"]);
    expect(logs[0]).toMatch(/^MODEL SWITCH claude:claude-sonnet-5-5 -> cursor:composer-2.5 \(.*hit your limit/);
    expect(logs[1]).toMatch(/^MODEL SWITCH cursor:composer-2.5 -> cursor:grok-example \(/);
    expect(order.current()).toBe(grok);
  });

  it("waits until the earliest reset when all models are limited, then starts again and does not exit", async () => {
    const order = new ModelOrder([claude, composer]);
    const slept: number[] = [];
    let round = 0;
    const fakeAgent = async (m: ModelSpec) => {
      if (round === 0) {
        if (m === composer) round = 1;
        throw new Error(m === claude ? "5-hour limit reached, resets 4:30am" : "usage limit, resets at 03:00");
      }
      return m.model;
    };
    const logs: string[] = [];
    const result = await withFallback(order, fakeAgent, { log: (s) => logs.push(s), sleep: async (ms) => void slept.push(ms), now: () => NOW });
    expect(slept).toEqual([2 * 60 * 60 * 1000]);
    expect(result).toBe("claude-sonnet-5-5");
    expect(logs.at(-1)).toContain("ALL MODELS LIMITED. Wait 120 min");
  });

  it("waits 30 minutes when no reset time is known", async () => {
    const order = new ModelOrder([claude]);
    const slept: number[] = [];
    let calls = 0;
    const result = await withFallback(order, async () => {
      if (calls++ < 1) throw new Error("rate limit");
      return "ok";
    }, { sleep: async (ms) => void slept.push(ms), now: () => NOW });
    expect(result).toBe("ok");
    expect(slept).toEqual([DEFAULT_LIMIT_WAIT_MS]);
  });

  it("throws other errors", async () => {
    const order = new ModelOrder([claude, composer]);
    await expect(withFallback(order, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(order.current()).toBe(claude);
  });

  it("accepts a log function as the third argument", async () => {
    const logs: string[] = [];
    const order = new ModelOrder([claude, composer]);
    await withFallback(order, async (m) => { if (m === claude) throw new Error("quota"); return 1; }, (s) => logs.push(s));
    expect(logs[0]).toContain("MODEL SWITCH");
  });
});

describe("limit errors and reset times", () => {
  it("detects limit texts", () => {
    expect(isLimitError("Rate limit hit")).toBe(true);
    expect(isLimitError("You've hit your weekly limit")).toBe(true);
    expect(isLimitError("5-hour limit reached")).toBe(true);
    expect(isLimitError("syntax error")).toBe(false);
  });

  it("reads clock and ISO reset times", () => {
    expect(parseResetTime("resets 4:30am", NOW)).toEqual(new Date(2026, 10, 10, 4, 30));
    expect(parseResetTime("resets at 16:05", NOW)).toEqual(new Date(2026, 10, 10, 16, 5));
    expect(parseResetTime("resets 12am", NOW)).toEqual(new Date(2026, 10, 11, 0, 0));
    expect(parseResetTime("resets 12:30pm", NOW)).toEqual(new Date(2026, 10, 10, 12, 30));
    expect(parseResetTime("resets 0:30", NOW)).toEqual(new Date(2026, 10, 11, 0, 30));
    expect(parseResetTime("resets at 2026-11-10T03:30:00Z", NOW)).toEqual(new Date("2026-11-10T03:30:00Z"));
    expect(parseResetTime("resets at 2026-13-99T99:99Z", NOW)).toBeUndefined();
    expect(parseResetTime("resets 25:00", NOW)).toBeUndefined();
    expect(parseResetTime("no time", NOW)).toBeUndefined();
  });

  it("takes the earliest future reset", () => {
    expect(waitForReset(["resets 3am", "resets 2am", "nothing"], NOW)).toBe(60 * 60 * 1000);
    expect(waitForReset(["nothing"], NOW, 5)).toBe(5);
  });
});

describe("no Cursor cloud agents", () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const sources = [
    ...["main.mts", "redact-filter.mts", "doctor.sh", "build-image.sh", "check-no-secrets.sh"].map((f) => join(root, f)),
    ...readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(root, "src", f)),
    join(root, "..", "sandcastle-loop.sh"),
  ];

  it("has no Cursor cloud agent API call in the loop code", () => {
    for (const file of sources) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/api\.cursor\.com|\/v\d+\/agents|background[- ]?agent|cloud[- ]?agent/i);
    }
  });
});
