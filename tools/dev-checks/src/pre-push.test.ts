import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Tests of scripts/hooks/pre-push. Each test uses a throwaway repository and a bare repository on the disk as its remote.
// The scripts/ci-local.sh of the throwaway repository is a stub: the real suite does not run and nothing uses the network.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const baseEnv = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Author",
  GIT_COMMITTER_EMAIL: "author@example.com",
};

// The stub records the commit and the number of changed files of its checkout. Its exit code comes from a file.
const STUB = `#!/usr/bin/env bash
echo "$(git rev-parse HEAD) $(git status --porcelain | wc -l)" >> "$STUB_CALLS"
echo "stub ci-local report"
exit "$(cat "$STUB_RESULT")"
`;

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "pre-push-"));
  dirs.push(dir);
  return dir;
}

interface Fixture {
  repo: string;
  remote: string;
  env: Record<string, string>;
  git: (...args: string[]) => string;
  commit: (file: string, text: string) => string;
  push: (...args: string[]) => { status: number | null; out: string };
  setResult: (exitCode: number) => void;
  calls: () => string[];
  remoteSha: (branch: string) => string;
}

function write(repo: string, file: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
  chmodSync(join(repo, file), mode);
}

/** A repository with a stub ci-local, the pre-push hook of this checkout and a bare remote. */
function fixture(hooksPath = join(root, "scripts", "hooks")): Fixture {
  const dir = temp();
  const repo = join(dir, "repo");
  const remote = join(dir, "remote.git");
  const env = { ...baseEnv, STUB_CALLS: join(dir, "calls.log"), STUB_RESULT: join(dir, "result"), TMPDIR: dir };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" }).trim();
  const commit = (file: string, text: string) => {
    write(repo, file, text, file.startsWith("scripts/") ? 0o755 : 0o644);
    git("add", "-A");
    git("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", `change ${file}`);
    return git("rev-parse", "HEAD");
  };
  const setResult = (exitCode: number) => writeFileSync(env.STUB_RESULT, `${exitCode}\n`);
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", "--bare", remote], { env });
  git("init", "-q", "-b", "feature");
  git("remote", "add", "origin", remote);
  commit("scripts/ci-local.sh", STUB);
  git("config", "core.hooksPath", hooksPath);
  setResult(0);
  return {
    repo,
    remote,
    env,
    git,
    commit,
    setResult,
    push: (...args) => {
      const result = spawnSync("git", ["push", ...args], { cwd: repo, env, encoding: "utf8" });
      return { status: result.status, out: result.stdout + result.stderr };
    },
    calls: () => (existsSync(env.STUB_CALLS) ? readFileSync(env.STUB_CALLS, "utf8").trim().split("\n") : []),
    remoteSha: (branch) => spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: remote, env, encoding: "utf8" }).stdout.trim(),
  };
}

describe("scripts/hooks/pre-push", () => {
  it("stops the push when ci-local is red", () => {
    const f = fixture();
    f.setResult(1);
    const sha = f.git("rev-parse", "HEAD");

    const result = f.push("origin", "feature");
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("stub ci-local report");
    expect(result.out).toContain(`pre-push: FAILED ci-local is red on ${sha}`);
    expect(result.out).toContain("--no-verify is not allowed");
    expect(f.calls()).toEqual([`${sha} 0`]);
    expect(f.remoteSha("feature")).toBe("");
  });

  it("lets the push pass when ci-local is green, and removes its temporary checkout", () => {
    const f = fixture();
    const sha = f.git("rev-parse", "HEAD");

    const result = f.push("origin", "feature");
    expect(result.out).toContain(`pre-push: ci-local is green on ${sha}`);
    expect(result.status).toBe(0);
    expect(f.calls()).toEqual([`${sha} 0`]);
    expect(f.remoteSha("feature")).toBe(sha);
    expect(f.git("worktree", "list").split("\n")).toHaveLength(1);
  });

  it("runs ci-local on the commit of the push, not on the files of the working directory", () => {
    const f = fixture();
    const pushed = f.git("rev-parse", "HEAD");
    f.git("branch", "other");
    const head = f.commit("a.md", "Child One\n");
    write(f.repo, "not-committed.md", "draft\n");

    expect(f.push("origin", "other").status).toBe(0);
    expect(f.calls()).toEqual([`${pushed} 0`]);
    expect(f.remoteSha("other")).toBe(pushed);
    expect(head).not.toBe(pushed);
  });

  it("uses the green cache for a second push of the same commit, and runs ci-local for a new commit", () => {
    const f = fixture();
    const first = f.git("rev-parse", "HEAD");
    expect(f.push("origin", "feature").status).toBe(0);

    f.setResult(1);
    const again = f.push("origin", "feature:copy");
    expect(again.status).toBe(0);
    expect(again.out).toContain(`pre-push: ${first} is in the green cache`);
    expect(f.calls()).toEqual([`${first} 0`]);
    expect(f.remoteSha("copy")).toBe(first);

    const second = f.commit("a.md", "Child One\n");
    expect(f.push("origin", "feature").status).not.toBe(0);
    expect(f.calls()).toEqual([`${first} 0`, `${second} 0`]);
    expect(f.remoteSha("feature")).toBe(first);
  });

  it("does not put a red commit in the cache", () => {
    const f = fixture();
    const sha = f.git("rev-parse", "HEAD");
    f.setResult(1);
    expect(f.push("origin", "feature").status).not.toBe(0);

    f.setResult(0);
    expect(f.push("origin", "feature").status).toBe(0);
    expect(f.calls()).toEqual([`${sha} 0`, `${sha} 0`]);
  });

  it("does not run ci-local for a branch delete", () => {
    const f = fixture();
    expect(f.push("origin", "feature").status).toBe(0);
    f.setResult(1);

    const result = f.push("origin", "--delete", "feature");
    expect(result.status).toBe(0);
    expect(result.out).toContain("pre-push: refs/heads/feature is a delete");
    expect(f.calls()).toHaveLength(1);
    expect(f.remoteSha("feature")).toBe("");
  });

  it("runs on a force push: red stops it, green lets it pass", () => {
    const f = fixture();
    const first = f.git("rev-parse", "HEAD");
    expect(f.push("origin", "feature").status).toBe(0);
    write(f.repo, "a.md", "Child One\n");
    f.git("add", "-A");
    f.git("-c", "core.hooksPath=/dev/null", "commit", "-q", "--amend", "-m", "new history");
    const rewritten = f.git("rev-parse", "HEAD");

    f.setResult(1);
    const red = f.push("-f", "origin", "feature");
    expect(red.status).not.toBe(0);
    expect(red.out).toContain(`pre-push: FAILED ci-local is red on ${rewritten}`);
    expect(f.remoteSha("feature")).toBe(first);

    f.setResult(0);
    expect(f.push("-f", "origin", "feature").status).toBe(0);
    expect(f.remoteSha("feature")).toBe(rewritten);
    expect(f.calls()).toEqual([`${first} 0`, `${rewritten} 0`, `${rewritten} 0`]);
  });

  it("runs ci-local one time for each different commit of one push, and one red commit stops all", () => {
    const f = fixture();
    const first = f.git("rev-parse", "HEAD");
    f.git("branch", "same");
    f.git("branch", "old");
    const second = f.commit("a.md", "Child One\n");

    expect(f.push("origin", "feature", "same", "old").status).toBe(0);
    expect(f.calls().sort()).toEqual([`${first} 0`, `${second} 0`].sort());
  });

  it("stops the push when the commit has no scripts/ci-local.sh", () => {
    const f = fixture();
    f.git("rm", "-q", "scripts/ci-local.sh");
    f.git("-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "remove ci-local");

    const result = f.push("origin", "feature");
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("has no scripts/ci-local.sh");
    expect(f.remoteSha("feature")).toBe("");
  });
});

describe("scripts/install-hooks.sh and the pre-push hook", () => {
  it("makes the hook run for a push from a worktree, with one green cache for all worktrees", () => {
    const f = fixture("/dev/null");
    const real = join(root, "scripts", "hooks", "pre-push");
    f.commit("scripts/hooks/pre-commit", "#!/usr/bin/env bash\nexit 0\n");
    f.commit("scripts/hooks/pre-push", `#!/usr/bin/env bash\necho "hook ran in $(pwd)" >&2\nexec "${real}" "$@"\n`);
    f.git("config", "--unset", "core.hooksPath");
    const sha = f.git("rev-parse", "HEAD");
    const worktree = join(dirname(f.repo), "worktree");
    f.git("worktree", "add", "-q", "-b", "side", worktree);
    const gitleaks = join(dirname(f.repo), "gitleaks");
    writeFileSync(gitleaks, "#!/bin/bash\nexit 0\n");
    chmodSync(gitleaks, 0o755);

    const install = spawnSync("bash", [join(root, "scripts", "install-hooks.sh")], { cwd: worktree, env: { ...f.env, GITLEAKS: gitleaks }, encoding: "utf8" });
    expect(install.stdout + install.stderr).toContain("install-hooks: core.hooksPath is scripts/hooks");
    expect(install.status).toBe(0);

    const fromWorktree = spawnSync("git", ["push", "origin", "side"], { cwd: worktree, env: f.env, encoding: "utf8" });
    expect(fromWorktree.stderr).toContain(`hook ran in ${worktree}`);
    expect(fromWorktree.status).toBe(0);
    expect(f.remoteSha("side")).toBe(sha);

    const fromMain = f.push("origin", "feature");
    expect(fromMain.out).toContain(`pre-push: ${sha} is in the green cache`);
    expect(fromMain.status).toBe(0);
    expect(f.calls()).toEqual([`${sha} 0`]);
  });

  it("fails in a checkout that has no scripts/hooks/pre-push", () => {
    const f = fixture("/dev/null");
    f.commit("scripts/hooks/pre-commit", "#!/usr/bin/env bash\nexit 0\n");

    const install = spawnSync("bash", [join(root, "scripts", "install-hooks.sh")], { cwd: f.repo, env: f.env, encoding: "utf8" });
    expect(install.status).not.toBe(0);
    expect(install.stderr).toContain("this checkout has no scripts/hooks/pre-push");
  });
});
