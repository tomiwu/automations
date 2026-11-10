import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RETRY_DELAYS, DEFAULT_TRANSIENT, errorText, isTransient, parseDelays, parseTransient, retryingExec, retrySync, sleepSync } from "./retry.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A fake gh that fails (like a TLS handshake timeout) a number of times, then prints the issue list.
function flakyGh(failures: number, error = "net/http: TLS handshake timeout"): { gh: string; calls: () => number } {
  const dir = mkdtempSync(join(tmpdir(), "loop-retry-"));
  dirs.push(dir);
  const counter = join(dir, "count");
  writeFileSync(counter, "0");
  const gh = join(dir, "gh");
  writeFileSync(gh, `#!/bin/sh
n=$(cat "${counter}"); n=$((n + 1)); echo "$n" > "${counter}"
if [ "$n" -le ${failures} ]; then echo "${error}" >&2; exit 1; fi
echo '[{"number":1}]'
`);
  chmodSync(gh, 0o755);
  return { gh, calls: () => Number(readFileSync(counter, "utf8")) };
}

describe("retryingExec", () => {
  it("retries a gh call that fails twice, then gives its output", () => {
    const { gh, calls } = flakyGh(2);
    const slept: number[] = [];
    const logs: string[] = [];
    const exec = (cmd: string, args: string[]) =>
      execFileSync(cmd === "gh" ? gh : cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const sh = retryingExec(exec, new Set(["gh"]), { delaysMs: parseDelays("5,15,45"), sleep: (ms) => slept.push(ms), log: (m) => logs.push(m) });
    expect(sh("gh", ["issue", "list", "--state", "open"])).toBe('[{"number":1}]');
    expect(calls()).toBe(3);
    expect(slept).toEqual([5000, 15000]);
    expect(logs).toEqual(["RETRY gh issue list: attempt 1 failed, retry in 5s", "RETRY gh issue list: attempt 2 failed, retry in 15s"]);
  });

  it("throws after the last attempt", () => {
    const { gh, calls } = flakyGh(10);
    const exec = (cmd: string, args: string[]) => execFileSync(cmd === "gh" ? gh : cmd, args, { encoding: "utf8", stdio: "pipe" });
    const sh = retryingExec(exec, new Set(["gh"]), { delaysMs: [0, 0], sleep: () => {} });
    expect(() => sh("gh", ["issue", "list"])).toThrow();
    expect(calls()).toBe(3);
  });

  it.each([
    ["unexpected EOF", "error connecting to api.github.com: unexpected EOF", 3],
    ["a PR number that is an issue", "GraphQL: Could not resolve to a PullRequest with the number of 5. (repository.pullRequest)", 1],
    ["HTTP 404", "HTTP 404: Not Found (https://api.github.com/repos/o/r/pulls/5)", 1],
    ["HTTP 401", "HTTP 401: Bad credentials (https://api.github.com/graphql)", 1],
    ["HTTP 502", "HTTP 502: Bad Gateway (https://api.github.com/graphql)", 3],
    ["the secondary rate limit", "You have exceeded a secondary rate limit", 3],
  ])("%s: the gh stub is called %i time(s)", (_name, error, expected) => {
    const { gh, calls } = flakyGh(10, error);
    const exec = (cmd: string, args: string[]) => execFileSync(cmd === "gh" ? gh : cmd, args, { encoding: "utf8", stdio: "pipe" });
    const sh = retryingExec(exec, new Set(["gh"]), { delaysMs: [0, 0], sleep: () => {} });
    expect(() => sh("gh", ["pr", "view"])).toThrow();
    expect(calls()).toBe(expected);
  });

  it("LOOP_RETRY_TRANSIENT adds a pattern", () => {
    const { gh, calls } = flakyGh(1, "proxy said: try again later");
    const exec = (cmd: string, args: string[]) => execFileSync(cmd === "gh" ? gh : cmd, args, { encoding: "utf8", stdio: "pipe" }).trim();
    const sh = retryingExec(exec, new Set(["gh"]), { delaysMs: [0], sleep: () => {}, transient: parseTransient("try again later") });
    expect(sh("gh", ["issue", "list"])).toBe('[{"number":1}]');
    expect(calls()).toBe(2);
  });

  it("does not retry other commands", () => {
    let calls = 0;
    const sh = retryingExec(() => {
      calls++;
      throw new Error("boom");
    }, new Set(["gh"]), { delaysMs: [0], sleep: () => {} });
    expect(() => sh("make", [])).toThrow("boom");
    expect(calls).toBe(1);
  });
});

describe("transient errors", () => {
  it("reads the message, stderr and stdout of an error", () => {
    const error = Object.assign(new Error("Command failed"), { stderr: Buffer.from("unexpected EOF"), stdout: "out" });
    expect(errorText(error)).toBe("Command failed\nunexpected EOF\nout");
    expect(errorText("plain")).toBe("plain");
    expect(isTransient(error)).toBe(true);
    expect(isTransient(new Error("HTTP 404: Not Found"))).toBe(false);
  });

  it("parses LOOP_RETRY_TRANSIENT and rejects a bad regex", () => {
    expect(parseTransient(undefined)).toEqual([...DEFAULT_TRANSIENT]);
    expect(parseTransient("busy").at(-1)!.test("Server BUSY")).toBe(true);
    expect(() => parseTransient("(")).toThrow("Bad LOOP_RETRY_TRANSIENT");
  });
});

describe("retrySync and the delays", () => {
  it("returns the first good result", () => {
    expect(retrySync("x", () => 7, { delaysMs: [1] })).toBe(7);
  });

  it("throws a permanent error at once, without a sleep", () => {
    let calls = 0;
    const slept: number[] = [];
    const run = () => {
      calls++;
      throw new Error("HTTP 401: Bad credentials");
    };
    expect(() => retrySync("gh api", run, { delaysMs: [5000], sleep: (ms) => slept.push(ms) })).toThrow("HTTP 401");
    expect([calls, slept]).toEqual([1, []]);
  });

  it("parses the delays in seconds and rejects bad values", () => {
    expect(parseDelays(DEFAULT_RETRY_DELAYS)).toEqual([5000, 15000, 45000, 90000]);
    expect(parseDelays("")).toEqual([]);
    expect(() => parseDelays("5,soon")).toThrow("LOOP_RETRY_DELAYS");
    expect(() => parseDelays("-1")).toThrow("LOOP_RETRY_DELAYS");
  });

  it("sleeps synchronously", () => {
    const start = Date.now();
    sleepSync(20);
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
