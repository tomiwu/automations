import { describe, expect, it, vi } from "vitest";

vi.mock("kody:runtime", () => ({
  fetch: async () => new Response("host"),
  getSecret: async () => "s",
  log: () => undefined,
  schedule: () => undefined,
}));

import { createKodyRuntime, kodyRuntime, type KodyHost } from "./kody.ts";

function host(overrides: Partial<KodyHost> = {}): KodyHost & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    fetch: async (input) => new Response(input),
    getSecret: async (name) => (name === "SET" ? "value" : undefined),
    log: (...args) => void calls.push(["log", ...args]),
    schedule: (...args) => void calls.push(["schedule", ...args]),
    ...overrides,
  };
}

describe("createKodyRuntime", () => {
  it("maps each call to the host", async () => {
    const kody = host();
    const runtime = createKodyRuntime(kody, () => new Date("2025-01-02T00:00:00Z"));
    await expect((await runtime.fetch("abc")).text()).resolves.toBe("abc");
    await expect(runtime.secret("SET")).resolves.toBe("value");
    expect(runtime.now().toISOString()).toBe("2025-01-02T00:00:00.000Z");
    runtime.log("error", "m");
    const task = async () => undefined;
    runtime.schedule({ cron: "* * * * *", timezone: "UTC" }, task);
    expect(kody.calls).toEqual([
      ["log", "error", "m"],
      ["schedule", { cron: "* * * * *", timezone: "UTC" }, task],
    ]);
  });

  it("rejects a missing or empty secret", async () => {
    const runtime = createKodyRuntime(host({ getSecret: async (n) => (n === "EMPTY" ? "" : undefined) }));
    await expect(runtime.secret("NONE")).rejects.toThrow("NONE");
    await expect(runtime.secret("EMPTY")).rejects.toThrow("EMPTY");
  });

  it("defaults to the real clock", () => {
    expect(createKodyRuntime(host()).now()).toBeInstanceOf(Date);
  });
});

describe("kodyRuntime", () => {
  it("uses the kody:runtime module", async () => {
    await expect(kodyRuntime.secret("any")).resolves.toBe("s");
    await expect((await kodyRuntime.fetch("x")).text()).resolves.toBe("host");
  });
});
