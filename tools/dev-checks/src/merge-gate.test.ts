import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Tests of scripts/ci-local-record.sh (the recorder) and scripts/ci-local-merge-gate.sh (the gate).
// Each test uses a throwaway repository. Its scripts/ci-local.sh is a stub: the real suite does not run.
// A fake `gh` is first in the PATH. It writes a line into a file when a script calls it. Nothing uses the network.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RECORDER = join(root, "scripts", "ci-local-record.sh");
const GATE = join(root, "scripts", "ci-local-merge-gate.sh");
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

// The stub records the commit and the number of changed files of its checkout. Its exit code comes from a file.
const STUB = `#!/usr/bin/env bash
echo "$(git rev-parse HEAD) $(git status --porcelain | wc -l)" >> "$STUB_CALLS"
echo "stub ci-local report, result: $([ "$(cat "$STUB_RESULT")" = 0 ] && echo GREEN || echo RED)"
echo "stub diagnostic line" >&2
exit "$(cat "$STUB_RESULT")"
`;
const FAKE_GH = `#!/usr/bin/env bash
echo "gh $*" >> "$GH_CALLS"
`;

interface Run {
  status: number | null;
  out: string;
}

interface Fixture {
  repo: string;
  git: (...args: string[]) => string;
  head: () => string;
  /** Writes the file, commits it and returns the new commit. */
  commit: (file: string, text: string) => string;
  record: (...args: string[]) => Run;
  gate: (...args: string[]) => Run;
  setResult: (exitCode: number) => void;
  calls: () => string[];
  ghCalls: () => string;
  recordFile: (sha: string) => string;
}

function write(file: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  chmodSync(file, mode);
}

/** A repository with a stub ci-local in its first commit. */
function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "merge-gate-"));
  dirs.push(dir);
  const repo = join(dir, "repo");
  write(join(dir, "bin", "gh"), FAKE_GH, 0o755);
  const env = {
    PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: "Test Author",
    GIT_AUTHOR_EMAIL: "author@example.com",
    GIT_COMMITTER_NAME: "Test Author",
    GIT_COMMITTER_EMAIL: "author@example.com",
    STUB_CALLS: join(dir, "calls.log"),
    STUB_RESULT: join(dir, "result"),
    GH_CALLS: join(dir, "gh.log"),
    TMPDIR: dir,
  };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
  const head = () => git("rev-parse", "HEAD");
  const run = (script: string, args: string[]): Run => {
    const result = spawnSync("bash", [script, ...args], { cwd: repo, env, encoding: "utf8" });
    return { status: result.status, out: result.stdout + result.stderr };
  };
  const commit = (file: string, text: string) => {
    write(join(repo, file), text, file.startsWith("scripts/") ? 0o755 : 0o644);
    git("add", "-A");
    git("commit", "-q", "-m", `change ${file}`);
    return head();
  };
  const setResult = (exitCode: number) => writeFileSync(env.STUB_RESULT, `${exitCode}\n`);
  mkdirSync(repo);
  git("init", "-q", "-b", "feature");
  commit("scripts/ci-local.sh", STUB);
  setResult(0);
  return {
    repo,
    git,
    head,
    commit,
    setResult,
    record: (...args) => run(RECORDER, args),
    gate: (...args) => run(GATE, args),
    calls: () => (existsSync(env.STUB_CALLS) ? readFileSync(env.STUB_CALLS, "utf8").trim().split("\n") : []),
    ghCalls: () => (existsSync(env.GH_CALLS) ? readFileSync(env.GH_CALLS, "utf8") : ""),
    recordFile: (sha) => join(repo, ".git", "ci-local-records", sha),
  };
}

describe("scripts/ci-local-record.sh", () => {
  it("writes a green record with the SHA, the result and the log of the run", () => {
    const f = fixture();
    const sha = f.head();

    const result = f.record();
    expect(result.out).toContain(`ci-local-record: GREEN record for ${sha}`);
    expect(result.status).toBe(0);
    const record = readFileSync(f.recordFile(sha), "utf8");
    expect(record).toContain(`sha: ${sha}\n`);
    expect(record).toContain("result: GREEN\n");
    expect(record).toContain("exit-code: 0\n");
    expect(record).toMatch(/recorded-at: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\n/);
    expect(record).toContain("stub ci-local report, result: GREEN");
    expect(record).toContain("stub diagnostic line");
    expect(f.calls()).toEqual([`${sha} 0`]);
    expect(f.git("worktree", "list").split("\n")).toHaveLength(1);
  });

  it("writes a red record, not a green record, when ci-local is red", () => {
    const f = fixture();
    const sha = f.head();
    f.setResult(7);

    const result = f.record();
    expect(result.status).toBe(1);
    expect(result.out).toContain(`ci-local-record: RED record for ${sha}`);
    const record = readFileSync(f.recordFile(sha), "utf8");
    expect(record).toContain("result: RED\n");
    expect(record).toContain("exit-code: 7\n");
    expect(record).not.toContain("result: GREEN\n");
  });

  it("replaces a green record of the SHA when a later run is red", () => {
    const f = fixture();
    const sha = f.head();
    expect(f.record().status).toBe(0);
    f.setResult(1);

    expect(f.record().status).toBe(1);
    expect(readFileSync(f.recordFile(sha), "utf8")).not.toContain("result: GREEN\n");
    expect(f.gate(sha).status).toBe(1);
  });

  it("runs ci-local on the given commit, not on the files of the working directory", () => {
    const f = fixture();
    const first = f.head();
    const second = f.commit("a.md", "Child One\n");
    write(join(f.repo, "not-committed.md"), "draft\n");

    expect(f.record(first).status).toBe(0);
    expect(f.calls()).toEqual([`${first} 0`]);
    expect(existsSync(f.recordFile(first))).toBe(true);
    expect(existsSync(f.recordFile(second))).toBe(false);
  });

  it("writes no record when the argument is not a commit", () => {
    const f = fixture();

    const result = f.record("no-such-ref");
    expect(result.status).toBe(2);
    expect(result.out).toContain("is not a commit");
    expect(f.calls()).toEqual([]);
    expect(existsSync(join(f.repo, ".git", "ci-local-records"))).toBe(false);
  });

  it("writes a red record when the commit has no scripts/ci-local.sh", () => {
    const f = fixture();
    f.git("rm", "-q", "scripts/ci-local.sh");
    f.git("commit", "-q", "-m", "remove ci-local");
    const sha = f.head();

    expect(f.record().status).toBe(1);
    expect(readFileSync(f.recordFile(sha), "utf8")).toContain("result: RED\n");
    expect(f.gate(sha).status).toBe(1);
  });
});

describe("scripts/ci-local-merge-gate.sh", () => {
  it("refuses the merge when SHA A has no record", () => {
    const f = fixture();
    const a = f.head();

    const result = f.gate(a);
    expect(result.status).toBe(1);
    expect(result.out).toContain(`ci-local-merge-gate: REFUSED no ci-local record for ${a}`);
  });

  it("allows the merge when SHA A has a green record", () => {
    const f = fixture();
    const a = f.head();
    expect(f.record().status).toBe(0);

    const result = f.gate(a);
    expect(result.out).toContain(`ci-local-merge-gate: ALLOWED green ci-local record for ${a}`);
    expect(result.status).toBe(0);
  });

  it("refuses the merge of SHA A when only SHA B has a green record", () => {
    const f = fixture();
    const b = f.head();
    expect(f.record().status).toBe(0);
    const a = f.commit("a.md", "Child One\n");

    expect(f.gate(b).status).toBe(0);
    const result = f.gate(a);
    expect(result.status).toBe(1);
    expect(result.out).toContain(`REFUSED no ci-local record for ${a}`);
  });

  it("refuses the merge of SHA A when its record file is a copy of the green record of SHA B", () => {
    const f = fixture();
    const b = f.head();
    expect(f.record().status).toBe(0);
    const a = f.commit("a.md", "Child One\n");
    writeFileSync(f.recordFile(a), readFileSync(f.recordFile(b), "utf8"));

    const result = f.gate(a);
    expect(result.status).toBe(1);
    expect(result.out).toContain(`REFUSED the record of ${a} is for a different SHA`);
  });

  it("refuses the merge when the record is red", () => {
    const f = fixture();
    const a = f.head();
    f.setResult(1);
    expect(f.record().status).toBe(1);

    const result = f.gate(a);
    expect(result.status).toBe(1);
    expect(result.out).toContain(`REFUSED the ci-local record for ${a} is not green`);
  });

  it("refuses a record file that has no green result line in its header", () => {
    const f = fixture();
    const a = f.head();
    write(f.recordFile(a), `sha: ${a}\n---\nresult: GREEN\n`);
    expect(f.gate(a).status).toBe(1);

    write(f.recordFile(a), "2026-11-11T10:00:00Z\n");
    expect(f.gate(a).status).toBe(1);
  });

  it("requires a new record after a sync with main changes the head SHA", () => {
    const f = fixture();
    const before = f.head();
    expect(f.record().status).toBe(0);
    f.git("branch", "main", "HEAD~0");
    f.git("checkout", "-q", "main");
    f.commit("main.md", "Example School\n");
    f.git("checkout", "-q", "feature");
    f.git("merge", "-q", "--no-ff", "-m", "sync with main", "main");
    const after = f.head();

    expect(after).not.toBe(before);
    expect(f.gate(after).status).toBe(1);
    expect(f.record().status).toBe(0);
    expect(f.gate(after).status).toBe(0);
  });

  it("accepts only one full commit SHA as its argument", () => {
    const f = fixture();
    const a = f.head();
    expect(f.record().status).toBe(0);

    for (const args of [[], ["HEAD"], [a.slice(0, 12)], [a, a], [`../ci-local-records/${a}`]]) {
      const result = f.gate(...args);
      expect(result.status).toBe(2);
      expect(result.out).toContain("usage: scripts/ci-local-merge-gate.sh <full commit SHA of the PR head>");
    }
  });

  it("does not call gh: the recorder and the gate do not merge", () => {
    const f = fixture();
    const a = f.head();
    expect(f.record().status).toBe(0);
    expect(f.gate(a).status).toBe(0);
    f.setResult(1);
    f.record();
    f.gate(a);

    expect(f.ghCalls()).toBe("");
    for (const script of [RECORDER, GATE]) {
      const code = readFileSync(script, "utf8").split("\n").filter((line) => !line.startsWith("#")).join("\n");
      expect(code).not.toMatch(/\bgh\b/);
    }
  });
});
