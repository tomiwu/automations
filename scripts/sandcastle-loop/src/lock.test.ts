import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, withLock } from "./lock.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function lockPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "loop-lock-"));
  dirs.push(dir);
  return join(dir, "checks.lock");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withLock", () => {
  it("runs one step at a time for one lock file", async () => {
    const path = lockPath();
    const events: string[] = [];
    const step = (name: string) => async () => {
      events.push(`${name} start`);
      await sleep(100);
      events.push(`${name} end`);
    };
    await Promise.all([withLock(path, step("a")), sleep(20).then(() => withLock(path, step("b")))]);
    expect(events).toEqual(["a start", "a end", "b start", "b end"]);
  });

  it("does nothing without a lock file", async () => {
    expect(await withLock(undefined, async () => 5)).toBe(5);
  });

  it("releases the lock when the step throws", async () => {
    const path = lockPath();
    await expect(withLock(path, async () => Promise.reject(new Error("fail")))).rejects.toThrow("fail");
    expect(await withLock(path, async () => "free")).toBe("free");
  });

  it("rejects when flock is missing or ends early", async () => {
    await expect(acquireLock(lockPath(), "/nonexistent/flock")).rejects.toThrow();
    await expect(acquireLock(lockPath(), "false")).rejects.toThrow("ended with code 1");
  });
});
