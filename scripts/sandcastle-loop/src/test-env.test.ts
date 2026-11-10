import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { hermeticEnv, realProgram, SYSTEM_PATH, waitForExit } from "./test-env.ts";

const here = dirname(fileURLToPath(import.meta.url));

describe("hermeticEnv", () => {
  it("gives a PATH of the stubs and the system directories only, and an empty HOME", () => {
    const box = hermeticEnv({ tool: "echo stub-tool" }, { env: { EXTRA: "1" } });
    try {
      expect(box.env).toEqual({ PATH: `${box.stubDir}:${SYSTEM_PATH}`, HOME: box.home, EXTRA: "1" });
      expect(readdirSync(box.home)).toEqual([]);
      expect(spawnSync("tool", [], { env: box.env, encoding: "utf8" }).stdout).toBe("stub-tool\n");
    } finally {
      box.cleanup();
    }
    expect(existsSync(box.stubDir)).toBe(false);
    expect(existsSync(box.home)).toBe(false);
  });

  it("links real programs, and node is the node of this run", () => {
    const box = hermeticEnv({}, { real: ["node"] });
    try {
      const r = spawnSync("node", ["-e", "console.log(process.execPath)"], { env: box.env, encoding: "utf8" });
      expect(r.stdout.trim()).toBe(process.execPath);
    } finally {
      box.cleanup();
    }
  });

  it("names a program that is not installed", () => {
    expect(() => realProgram("no-such-program-example")).toThrow("The program no-such-program-example is not installed");
  });

  it("removes a directory that a test made read-only", () => {
    const box = hermeticEnv();
    spawnSync("chmod", ["500", box.home]);
    box.cleanup();
    expect(existsSync(box.home)).toBe(false);
  });
});

describe("waitForExit", () => {
  it("returns when a background process (not a child of the test) ended", () => {
    const pid = Number(spawnSync("sh", ["-c", "sleep 0.2 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).stdout.trim());
    const start = Date.now();
    waitForExit(pid, 5000);
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });

  it("throws when the process still runs after the timeout", () => {
    const child = spawn("sleep", ["5"], { stdio: "ignore" });
    try {
      expect(() => waitForExit(child.pid!, 100)).toThrow(`Process ${child.pid} still runs after 100 ms`);
    } finally {
      child.kill();
    }
  });
});

describe("the script tests", () => {
  it("do not use the PATH of the machine", () => {
    const files = readdirSync(here).filter((name) => name.endsWith(".test.ts") && name !== "test-env.test.ts");
    const leaks = files.filter((name) => readFileSync(join(here, name), "utf8").includes("process.env.PATH"));
    expect(leaks).toEqual([]);
    expect(statSync(join(here, "test-env.ts")).isFile()).toBe(true);
  });
});
