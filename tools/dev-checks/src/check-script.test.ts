import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = new URL("../../../scripts/check.sh", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function stubs(options: { failNpm?: string; gitleaks?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "check-"));
  dirs.push(dir);
  const log = join(dir, "calls.log");
  const write = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/bash\necho "${name} $*" >> "${log}"\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  write("git", `echo "${dir}"`);
  write("npm", options.failNpm ? `[ "$*" = "${options.failNpm}" ] && exit 1\nexit 0` : "exit 0");
  if (options.gitleaks) write("gitleaks", "exit 0");
  const result = spawnSync("/bin/bash", [script], { encoding: "utf8", env: { PATH: `${dir}:/usr/bin:/bin` } });
  return { result, calls: readFileSync(log, "utf8").trim().split("\n").filter((line) => !line.startsWith("git ")) };
}

describe("check.sh", () => {
  it("runs typecheck, test, crap, privacy and gitleaks in order", () => {
    const { result, calls } = stubs({ gitleaks: true });
    expect(result.status).toBe(0);
    expect(calls).toEqual(["npm run typecheck", "npm test", "npm run crap", "npm run --silent privacy", "gitleaks git --no-banner --redact --exit-code 1 ."]);
    expect(result.stdout).toContain("check: all steps passed");
  });

  it("stops at the first failed step and names it", () => {
    const { result, calls } = stubs({ failNpm: "test", gitleaks: true });
    expect(result.status).toBe(1);
    expect(calls).toEqual(["npm run typecheck", "npm test"]);
    expect(result.stderr.trim()).toBe('check: FAILED at step "test"');
  });

  it("prints one warning line when gitleaks is not installed", () => {
    const { result } = stubs();
    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe("check: WARNING gitleaks is not installed, the secret scan did not run");
  });
});
