import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scriptsDir = join(root, "..");
const tsx = join(root, "..", "..", "node_modules", ".bin", "tsx");
const FAKE_TOKEN = "sk-ant-FAKE0123456789abcdef";
const FAKE_PLAIN = "fake-plain-secret-value-42";
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loop-secrets-"));
  dirs.push(dir);
  return dir;
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("redact-filter with a failing podman", () => {
  it("writes [REDACTED] and not the secret values to the log", () => {
    const dir = tempDir();
    executable(join(dir, "podman"), `echo "podman run -e CLAUDE_CODE_OAUTH_TOKEN=$FAKE_OAUTH -e OTHER=$FAKE_PLAIN image" >&2\nexit 125`);
    const envFile = join(dir, "fake.env");
    writeFileSync(envFile, `SOME_VALUE=${FAKE_PLAIN}\n`);
    const log = join(dir, "run.log");
    const result = spawnSync(
      "bash",
      ["-c", `podman run image 2>&1 | "${tsx}" "${join(root, "redact-filter.mts")}" > "${log}"`],
      {
        env: { PATH: `${dir}:${process.env.PATH}`, FAKE_OAUTH: FAKE_TOKEN, FAKE_PLAIN, REDACT_ENV_FILE: envFile },
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    const text = readFileSync(log, "utf8");
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain(FAKE_TOKEN);
    expect(text).not.toContain(FAKE_PLAIN);
  });
});

describe("check-no-secrets.sh", () => {
  const script = join(root, "check-no-secrets.sh");

  it("fails on a log with a token and prints no token value", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "bad.log"), `run -e CLAUDE_CODE_OAUTH_TOKEN=${FAKE_PLAIN}\ntoken ${FAKE_TOKEN}\n`);
    const result = spawnSync(script, [dir], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(join(dir, "bad.log"));
    expect(result.stdout).toContain("2 match");
    const output = result.stdout + result.stderr;
    expect(output).not.toContain(FAKE_TOKEN);
    expect(output).not.toContain(FAKE_PLAIN);
  });

  it("passes on a clean log and on a redacted log", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "clean.log"), "Iteration 1\nCLAUDE_CODE_OAUTH_TOKEN=[REDACTED]\n");
    const result = spawnSync(script, [dir], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("needs a directory argument", () => {
    expect(spawnSync(script, [], { encoding: "utf8" }).status).not.toBe(0);
  });
});

describe("sandcastle-loop.sh", () => {
  it("creates the log file with mode 600", () => {
    const dir = tempDir();
    const logDir = join(dir, "logs");
    executable(join(dir, "npx"), "exit 0");
    const result = spawnSync(join(scriptsDir, "sandcastle-loop.sh"), [], {
      env: { PATH: `${dir}:${process.env.PATH}`, LOOP_REPO: "owner/example", LOOP_LOG_DIR: logDir },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    const logs = readdirSync(logDir).filter((f) => /^\d{8}-\d{4}\.log$/.test(f));
    expect(logs).toHaveLength(1);
    expect((statSync(join(logDir, logs[0]!)).mode & 0o777).toString(8)).toBe("600");
    expect(existsSync(join(logDir, "current.log"))).toBe(true);
  });
});
