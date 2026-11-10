import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Helpers for the tests of the shell scripts. A test must not depend on the programs of the machine
 * that runs it: CI has no `node` in /usr/bin, the box has other programs than CI.
 */

/** The system directories that a hermetic PATH keeps after the stub directory. */
export const SYSTEM_PATH = "/usr/bin:/bin";

export interface HermeticOptions {
  /** Real programs to link into the stub directory (for example `node`, `git`). `node` is the node of this test run. */
  real?: readonly string[];
  /** More environment variables. */
  env?: Record<string, string>;
}

export interface Hermetic {
  stubDir: string;
  home: string;
  /** `PATH` is the stub directory plus `SYSTEM_PATH`. `HOME` is a new empty directory. Nothing else is inherited. */
  env: Record<string, string>;
  /** Writes one more stub program (a `/bin/sh` script). */
  stub(name: string, body: string): void;
  /** Removes the stub directory and the home directory, also when a test made them read-only. */
  cleanup(): void;
}

/** The path of a real program on the PATH of the test run. */
export function realProgram(name: string): string {
  if (name === "node") return process.execPath;
  const found = spawnSync("sh", ["-c", `command -v "$0"`, name], { encoding: "utf8" }).stdout.trim();
  if (found === "") throw new Error(`The program ${name} is not installed`);
  return found;
}

/** A clean environment with stub programs and a temporary HOME. */
export function hermeticEnv(stubs: Record<string, string> = {}, options: HermeticOptions = {}): Hermetic {
  const stubDir = mkdtempSync(join(tmpdir(), "loop-stub-"));
  const home = mkdtempSync(join(tmpdir(), "loop-home-"));
  const stub = (name: string, body: string) => {
    writeFileSync(join(stubDir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(stubDir, name), 0o755);
  };
  Object.entries(stubs).forEach(([name, body]) => stub(name, body));
  (options.real ?? []).forEach((name) => symlinkSync(realProgram(name), join(stubDir, name)));
  const cleanup = () => {
    for (const dir of [stubDir, home]) {
      spawnSync("chmod", ["-R", "u+rwx", dir]);
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return { stubDir, home, env: { PATH: `${stubDir}:${SYSTEM_PATH}`, HOME: home, ...options.env }, stub, cleanup };
}

// A zombie (ended, but not yet reaped by an init that does not wait) is not alive.
const isZombie = (pid: number): boolean => {
  try {
    return /^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return false;
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return !isZombie(pid);
  } catch {
    return false;
  }
};

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Waits until a background process ends, so that a test does not remove a directory that it still writes
 * to. It throws after `timeoutMs`, so a hanging process fails the test with a clear message. Use it for a
 * process that a script started in the background (not a direct child of the test, which stays a zombie
 * until the event loop runs).
 */
export function waitForExit(pid: number, timeoutMs = 5000): void {
  const end = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() > end) throw new Error(`Process ${pid} still runs after ${timeoutMs} ms`);
    pause(20);
  }
}
