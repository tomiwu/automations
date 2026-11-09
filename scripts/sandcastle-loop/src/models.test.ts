import { describe, expect, it } from "vitest";
import type { ModelSpec } from "./config.ts";
import { isLimitError, ModelOrder, withFallback } from "./models.ts";

const a: ModelSpec = { provider: "claude", model: "model-a" };
const b: ModelSpec = { provider: "cursor", model: "model-b" };

describe("withFallback", () => {
  it("returns the result of the first model", async () => {
    const order = new ModelOrder([a, b]);
    expect(await withFallback(order, async (m) => m.model)).toBe("model-a");
  });

  it("changes to the next model on a limit error and keeps it", async () => {
    const order = new ModelOrder([a, b]);
    const logs: string[] = [];
    const tried: string[] = [];
    const run = async (m: ModelSpec) => {
      tried.push(m.model);
      if (m === a) throw new Error("Usage limit reached");
      return "ok";
    };
    expect(await withFallback(order, run, (s) => logs.push(s))).toBe("ok");
    expect(tried).toEqual(["model-a", "model-b"]);
    expect(logs[0]).toContain("Change to cursor:model-b");
    expect(order.current()).toBe(b);
  });

  it("throws other errors", async () => {
    const order = new ModelOrder([a, b]);
    await expect(withFallback(order, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(order.current()).toBe(a);
  });

  it("throws a limit error when no model is left", async () => {
    const order = new ModelOrder([a]);
    await expect(withFallback(order, async () => { throw new Error("quota"); })).rejects.toThrow("quota");
  });
});

describe("isLimitError", () => {
  it("detects limit texts", () => {
    expect(isLimitError("Rate limit hit")).toBe(true);
    expect(isLimitError("syntax error")).toBe(false);
  });
});
