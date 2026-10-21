import { describe, expect, it } from "vitest";
import { fakeRuntime, nodeRuntime } from "./index.ts";

describe("fakeRuntime", () => {
  it("returns a secret and rejects a missing secret", async () => {
    const runtime = fakeRuntime({ secrets: { CHILD1_LIBRUS_LOGIN: "value" } });
    await expect(runtime.secret("CHILD1_LIBRUS_LOGIN")).resolves.toBe("value");
    await expect(runtime.secret("OTHER")).rejects.toThrow("OTHER");
  });

  it("records requests and answers with the given response", async () => {
    const runtime = fakeRuntime({ respond: () => new Response("ok", { status: 201 }) });
    const response = await runtime.fetch("https://example.test/a", { method: "POST" });
    expect(response.status).toBe(201);
    expect(runtime.requests).toEqual([{ input: "https://example.test/a", init: { method: "POST" } }]);
  });

  it("answers with an empty response by default", async () => {
    const response = await fakeRuntime().fetch("https://example.test/");
    expect(response.status).toBe(200);
  });

  it("controls the clock", () => {
    const runtime = fakeRuntime({ now: new Date("2025-02-03T04:05:06Z") });
    expect(runtime.now().toISOString()).toBe("2025-02-03T04:05:06.000Z");
    runtime.setNow(new Date("2025-03-01T00:00:00Z"));
    expect(runtime.now().toISOString()).toBe("2025-03-01T00:00:00.000Z");
  });

  it("records logs and scheduled tasks", async () => {
    const runtime = fakeRuntime();
    runtime.log("warn", "message");
    let ran = false;
    runtime.schedule({ cron: "0 7 * * *", timezone: "Europe/Warsaw" }, async () => {
      ran = true;
    });
    expect(runtime.logs).toEqual([{ level: "warn", message: "message" }]);
    await runtime.scheduled[0]?.task();
    expect(ran).toBe(true);
    expect(runtime.scheduled[0]?.schedule.cron).toBe("0 7 * * *");
  });
});

describe("nodeRuntime", () => {
  it("reads secrets from the environment", async () => {
    const runtime = nodeRuntime({ env: { A: "x", EMPTY: "" } });
    await expect(runtime.secret("A")).resolves.toBe("x");
    await expect(runtime.secret("EMPTY")).rejects.toThrow("EMPTY");
    await expect(runtime.secret("MISSING")).rejects.toThrow("MISSING");
  });

  it("writes logs to the sink and reads the clock", () => {
    const lines: string[] = [];
    const runtime = nodeRuntime({ env: {}, sink: (line) => lines.push(line) });
    runtime.log("info", "hello");
    expect(lines).toEqual(["[info] hello"]);
    expect(Math.abs(runtime.now().getTime() - Date.now())).toBeLessThan(1000);
  });

  it("runs a scheduled task once", async () => {
    const runtime = nodeRuntime({ env: {} });
    let count = 0;
    runtime.schedule({ cron: "* * * * *", timezone: "UTC" }, async () => {
      count += 1;
    });
    await Promise.resolve();
    expect(count).toBe(1);
  });

  it("uses global fetch and the default sink and environment", async () => {
    const runtime = nodeRuntime();
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("net")) as typeof fetch;
    try {
      await expect((await runtime.fetch("https://example.test/")).text()).resolves.toBe("net");
    } finally {
      globalThis.fetch = original;
    }
    await expect(runtime.secret("AUTOMATIONS_SURELY_UNSET_NAME")).rejects.toThrow();
  });
});
