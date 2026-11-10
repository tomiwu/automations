import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SKIP_NOTICE, skipNotice } from "./skip-notice.js";

// Tests of scripts/test-sql-local.sh (issue #192). They use a stub engine, so no container starts.
const script = new URL("../../../scripts/test-sql-local.sh", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A directory with a stub `podman` that logs its arguments. `port` prints a port; `exec` (pg_isready) succeeds. */
function stubEngine(runExit = 0) {
  const dir = mkdtempSync(join(tmpdir(), "sql-local-"));
  dirs.push(dir);
  const log = join(dir, "calls.log");
  writeFileSync(
    join(dir, "podman"),
    `#!/bin/bash\necho "$*" >> "${log}"\ncase "$1" in\n  run) exit ${runExit} ;;\n  port) echo "127.0.0.1:55432" ;;\nesac\nexit 0\n`,
  );
  chmodSync(join(dir, "podman"), 0o755);
  return { dir, calls: () => readFileSync(log, "utf8").trim().split("\n") };
}

const run = (path: string, env: Record<string, string> = {}) =>
  spawnSync("/bin/bash", [script], { encoding: "utf8", env: { PATH: path, ...env } });

describe("test-sql-local.sh", () => {
  it("fails with one clear line without podman or docker", () => {
    const dir = mkdtempSync(join(tmpdir(), "sql-local-empty-"));
    dirs.push(dir);
    const result = run(dir);
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe("test:sql:local: podman or docker is necessary, and neither is installed");
  });

  it("gives the tests the URL of the container and removes the container when the tests fail", () => {
    const engine = stubEngine();
    const tests = join(engine.dir, "failing-tests");
    writeFileSync(tests, '#!/bin/bash\necho "url=$TEST_DATABASE_URL"\nexit 3\n');
    chmodSync(tests, 0o755);
    const result = run(`${engine.dir}:/usr/bin:/bin`, { SQL_TEST_COMMAND: tests });
    expect(result.status).toBe(3);
    expect(result.stdout).toContain("url=postgresql://postgres:postgres@127.0.0.1:55432/postgres");
    const calls = engine.calls();
    expect(calls[0]).toMatch(/^run -d --rm --name sql-tests-\d+-\d+ .*-p 127\.0\.0\.1::5432 docker\.io\/library\/postgres:17$/);
    expect(calls.at(-1)).toMatch(/^rm -f sql-tests-/);
  });

  it("removes the container also when the tests pass", () => {
    const engine = stubEngine();
    expect(run(`${engine.dir}:/usr/bin:/bin`, { SQL_TEST_COMMAND: "true" }).status).toBe(0);
    expect(engine.calls().at(-1)).toMatch(/^rm -f sql-tests-/);
  });

  it("stops with one line when the container does not start", () => {
    const engine = stubEngine(125);
    const result = run(`${engine.dir}:/usr/bin:/bin`, { SQL_TEST_COMMAND: "true" });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toBe("test:sql:local: could not start postgres:17 with podman");
  });
});

describe("skipNotice", () => {
  it("names the local command when TEST_DATABASE_URL is not set, and is empty when it is set", () => {
    expect(skipNotice({})).toEqual([SKIP_NOTICE]);
    expect(SKIP_NOTICE).toContain("npm run test:sql:local");
    expect(skipNotice({ TEST_DATABASE_URL: "postgresql://example.invalid/db" })).toEqual([]);
  });
});
