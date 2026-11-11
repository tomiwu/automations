import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ALLOWLIST_PATH, run } from "./run.ts";
import { isSkipped } from "./sources.ts";

// Tests of scripts/clean-publish.sh, scripts/hooks/pre-commit, scripts/install-hooks.sh and the privacy step of scripts/ci-local.sh.
// Every repository is a throwaway one with invented data. The positive samples are built at run time.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const privateEmail = ["some.parent", "private-mail.net"].join("@");
const phone = ["+48", "601", "234", "567"].join(" ");
const env = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Private Person",
  GIT_AUTHOR_EMAIL: privateEmail,
  GIT_COMMITTER_NAME: "Private Person",
  GIT_COMMITTER_EMAIL: privateEmail,
};
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, env, encoding: "utf8" });

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "publish-"));
  dirs.push(dir);
  return dir;
}

function stage(repo: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, "add", "-A");
}

function commit(repo: string, files: Record<string, string>, message: string): void {
  stage(repo, files);
  git(repo, "commit", "-q", "-m", message);
}

/** A source repository with a clean tree and a history with a private author, message and removed line. */
function source(): string {
  const repo = join(temp(), "source");
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  commit(repo, { "README.md": "Child One\n", "docs/notes.md": `tel ${phone}\n`, "private/loop.md": "owner tooling\n" }, "first");
  commit(repo, { "docs/notes.md": "clean\n" }, `remove the number, ask ${privateEmail}`);
  return repo;
}

function publish(repo: string, extraEnv: Record<string, string> = {}) {
  const target = join(temp(), "public");
  const result = spawnSync("bash", [join(root, "scripts", "clean-publish.sh"), target, "--source", repo], { env: { ...env, ...extraEnv }, encoding: "utf8" });
  return { target, status: result.status, out: result.stdout + result.stderr };
}

describe("scripts/clean-publish.sh", () => {
  it("makes a repository with one commit, a neutral author and no finding in its history", () => {
    const repo = source();
    const { target, status, out } = publish(repo);
    expect(out).toContain("clean-publish: nothing was published");
    expect(status).toBe(0);
    expect(git(target, "log", "--all", "--format=%an <%ae> %cn <%ce> %s").trim()).toBe(
      "The automations contributors <noreply@example.com> The automations contributors <noreply@example.com> Initial public release",
    );
    expect(git(target, "ls-files").trim().split("\n")).toEqual(["README.md", "docs/notes.md", "private/loop.md"]);
    expect(git(target, "remote")).toBe("");
    expect(git(target, "log", "--all", "-p")).not.toContain(privateEmail);
    expect(out).not.toContain(privateEmail);
  });

  it("leaves out the paths of privacy/publish-exclude.txt", () => {
    const repo = source();
    commit(repo, { "privacy/publish-exclude.txt": "# owner tooling\nprivate/\n" }, "exclude");
    const { target, status } = publish(repo);
    expect(status).toBe(0);
    expect(existsSync(join(target, "private"))).toBe(false);
    expect(existsSync(join(target, "README.md"))).toBe(true);
  });

  it("stops and makes nothing when the source tree has a finding", () => {
    const repo = source();
    commit(repo, { "docs/contact.md": `${privateEmail}\n` }, "contact");
    const { target, status, out } = publish(repo);
    expect(status).toBe(1);
    expect(out).toContain("docs/contact.md:1:email");
    expect(out).toContain("clean-publish: FAILED the source tree has privacy findings");
    expect(existsSync(target)).toBe(false);
  });

  it("removes the new repository when the new history has a finding", () => {
    const { target, status, out } = publish(source(), { PUBLISH_AUTHOR_EMAIL: privateEmail });
    expect(status).toBe(1);
    expect(out).toContain("clean-publish: FAILED the new repository has privacy findings. It was removed.");
    expect(existsSync(target)).toBe(false);
  });

  it("stops when the source has uncommitted changes", () => {
    const repo = source();
    writeFileSync(join(repo, "new.txt"), "x\n");
    const { status, out } = publish(repo);
    expect(status).toBe(1);
    expect(out).toContain("uncommitted changes");
  });

  it("removes the new repository when gitleaks finds a secret", () => {
    const stub = join(temp(), "gitleaks");
    writeFileSync(stub, "#!/bin/bash\nexit 1\n");
    chmodSync(stub, 0o755);
    const { target, status, out } = publish(source(), { GITLEAKS: stub });
    expect(status).toBe(1);
    expect(out).toContain("gitleaks found a secret");
    expect(existsSync(target)).toBe(false);
  });

  it("gives exit code 2 without a target", () => {
    const result = spawnSync("bash", [join(root, "scripts", "clean-publish.sh")], { env, encoding: "utf8" });
    expect(result.status).toBe(2);
  });
});

/** A stub gitleaks program. It records its arguments in `<stub>.calls`. */
function stubGitleaks(exitCode: number): string {
  const stub = join(temp(), "gitleaks");
  writeFileSync(stub, `#!/bin/bash\necho "$*" >> "${stub}.calls"\nexit ${exitCode}\n`);
  chmodSync(stub, 0o755);
  return stub;
}

/** The real gitleaks program (GITLEAKS, the PATH, or the cache of scripts/install-hooks.sh), if this computer has one. */
function realGitleaks(): string | undefined {
  const cached = join(process.env.XDG_CACHE_HOME ?? join(process.env.HOME ?? "", ".cache"), "ci-local", "gitleaks");
  const inPath = spawnSync("bash", ["-c", "command -v gitleaks"], { encoding: "utf8" }).stdout.trim();
  return [process.env.GITLEAKS ?? "", inPath, cached].find((path) => path !== "" && existsSync(path));
}

function tryCommit(repo: string, gitleaks: string, message = "change") {
  const result = spawnSync("git", ["commit", "-q", "-m", message], { cwd: repo, env: { ...env, GITLEAKS: gitleaks }, encoding: "utf8" });
  return { status: result.status, out: result.stdout + result.stderr, head: git(repo, "log", "-1", "--format=%s").trim() };
}

/** Makes the repository use the pre-commit hook of this checkout. */
function useHook(repo: string): void {
  git(repo, "config", "core.hooksPath", join(root, "scripts", "hooks"));
}

/** A throwaway repository that uses the pre-commit hook of this checkout. */
function hooked(): string {
  const repo = source();
  useHook(repo);
  return repo;
}

describe("scripts/hooks/pre-commit", () => {
  it("stops a commit with a staged privacy finding and lets a clean commit pass", () => {
    const repo = hooked();
    const gitleaks = stubGitleaks(0);
    stage(repo, { "a.md": "Child Two\n" });
    expect(tryCommit(repo, gitleaks, "clean")).toMatchObject({ status: 0, head: "clean" });

    stage(repo, { "b.md": `${phone}\n` });
    const result = tryCommit(repo, gitleaks, "phone");
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("b.md:1:phone");
    expect(result.out).toContain("pre-commit: FAILED privacy");
    expect(result.out).not.toContain(phone);
    expect(result.head).toBe("clean");
  });

  it("runs gitleaks on the staged changes with the flags of ci-local, and stops the commit on a leak", () => {
    const repo = hooked();
    const clean = stubGitleaks(0);
    stage(repo, { "a.md": "Child Two\n" });
    expect(tryCommit(repo, clean, "clean").status).toBe(0);
    expect(readFileSync(`${clean}.calls`, "utf8").trim()).toBe("git --pre-commit --staged --redact --verbose --no-banner --exit-code 1 .");

    stage(repo, { "c.md": "Child Three\n" });
    const result = tryCommit(repo, stubGitleaks(1), "leak");
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("pre-commit: FAILED gitleaks");
    expect(result.out).toContain("--no-verify is not allowed");
    expect(result.head).toBe("clean");
  });

  it("stops the commit when gitleaks is not installed", () => {
    const repo = hooked();
    stage(repo, { "a.md": "Child Two\n" });
    const result = tryCommit(repo, join(temp(), "no-gitleaks"));
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("gitleaks is not installed. Run scripts/install-hooks.sh");
    expect(result.head).not.toBe("change");
  });

  it("uses the same gitleaks version and flags as scripts/ci-local.sh", () => {
    const ciLocal = readFileSync(join(root, "scripts", "ci-local.sh"), "utf8");
    const installer = readFileSync(join(root, "scripts", "install-hooks.sh"), "utf8");
    const hook = readFileSync(join(root, "scripts", "hooks", "pre-commit"), "utf8");
    expect(ciLocal).toContain("download/v8.28.0/gitleaks_8.28.0_linux_x64.tar.gz");
    expect(installer).toContain("GITLEAKS_VERSION=8.28.0");
    expect(ciLocal).toContain("git --redact --verbose --exit-code 1 .");
    expect(hook).toMatch(/git --pre-commit --staged --redact --verbose --no-banner --exit-code 1 \.$/m);
  });

  describe("the typecheck of the staged workspaces", () => {
    function workspaceRepo(typecheck: string): string {
      const repo = source();
      commit(repo, {
        "package.json": JSON.stringify({ name: "example", private: true, workspaces: ["packages/*"] }),
        "packages/one/package.json": JSON.stringify({ name: "@example/one", version: "1.0.0", scripts: { typecheck } }),
      }, "workspaces");
      useHook(repo);
      return repo;
    }
    const fails = "echo typecheck-ran && exit 1";

    it("stops the commit when the typecheck of a staged workspace fails", () => {
      const repo = workspaceRepo(fails);
      stage(repo, { "packages/one/src/a.ts": "export const a = 1;\n" });
      const result = tryCommit(repo, stubGitleaks(0));
      expect(result.status).not.toBe(0);
      expect(result.out).toContain("typecheck-ran");
      expect(result.out).toContain("pre-commit: FAILED typecheck");
      expect(result.head).toBe("workspaces");
    });

    it("does not run the typecheck of a workspace without a staged file", () => {
      const repo = workspaceRepo(fails);
      stage(repo, { "docs/a.md": "Child Two\n" });
      const result = tryCommit(repo, stubGitleaks(0));
      expect(result.out).not.toContain("typecheck-ran");
      expect(result).toMatchObject({ status: 0, head: "change" });
    });

    it("lets the commit pass when the typecheck of the staged workspace passes", () => {
      const repo = workspaceRepo("echo typecheck-ran");
      stage(repo, { "packages/one/src/a.ts": "export const a = 1;\n" });
      const result = tryCommit(repo, stubGitleaks(0));
      expect(result.out).toContain("typecheck-ran");
      expect(result).toMatchObject({ status: 0, head: "change" });
    });
  });

  // These cases use the real gitleaks program. They are skipped on a computer without gitleaks.
  describe.skipIf(realGitleaks() === undefined)("with the real gitleaks", () => {
    const gitleaks = realGitleaks() ?? "";
    const secret = ["ghp", "x7Kq2LmN9pRt4VwY8zBc3DfG6hJs5MnP1QaE"].join("_");
    const leak = { "src/config.ts": `export const key = "${secret}";\n` };

    it("stops a commit with a staged synthetic leak that is not in .gitleaksignore, and prints no secret value", () => {
      const repo = hooked();
      stage(repo, leak);
      const result = tryCommit(repo, gitleaks, "leak");
      expect(result.status).not.toBe(0);
      expect(result.out).toContain("src/config.ts:github-pat:1");
      expect(result.out).toContain("REDACTED");
      expect(result.out).toContain("pre-commit: FAILED gitleaks");
      expect(result.out).not.toContain(secret);
      expect(result.out).not.toContain(secret.slice(4, 16));
      expect(result.head).not.toBe("leak");
    });

    it("lets a staged leak of .gitleaksignore and a clean change pass", () => {
      const repo = hooked();
      stage(repo, { ...leak, ".gitleaksignore": "src/config.ts:github-pat:1\n" });
      expect(tryCommit(repo, gitleaks, "allowlisted")).toMatchObject({ status: 0, head: "allowlisted" });
      stage(repo, { "a.md": "Child Two\n" });
      expect(tryCommit(repo, gitleaks, "clean")).toMatchObject({ status: 0, head: "clean" });
    });
  });
});

describe("scripts/install-hooks.sh", () => {
  const install = (cwd: string, gitleaks: string) => {
    const result = spawnSync("bash", [join(root, "scripts", "install-hooks.sh")], { cwd, env: { ...env, GITLEAKS: gitleaks }, encoding: "utf8" });
    return { status: result.status, out: result.stdout + result.stderr };
  };

  /** A repository whose scripts/hooks/pre-commit runs the hook of this checkout. */
  function withHook(): string {
    const repo = source();
    commit(repo, { "scripts/hooks/pre-commit": `#!/usr/bin/env bash\necho "hook ran in $(pwd)"\nexec "${join(root, "scripts", "hooks", "pre-commit")}"\n` }, "hook");
    chmodSync(join(repo, "scripts", "hooks", "pre-commit"), 0o755);
    git(repo, "commit", "-q", "-am", "hook mode");
    return repo;
  }

  it("sets core.hooksPath on the common config, so the hook runs in every worktree", () => {
    const repo = withHook();
    const gitleaks = stubGitleaks(0);
    const worktree = join(temp(), "worktree");
    git(repo, "worktree", "add", "-q", "-b", "side", worktree);

    const result = install(worktree, gitleaks);
    expect(result.out).toContain("install-hooks: core.hooksPath is scripts/hooks");
    expect(result.status).toBe(0);
    expect(git(repo, "config", "--get", "core.hooksPath").trim()).toBe("scripts/hooks");
    expect(git(worktree, "config", "--get", "core.hooksPath").trim()).toBe("scripts/hooks");
    expect(existsSync(join(repo, ".git", "hooks", "pre-commit"))).toBe(false);

    const later = join(temp(), "later");
    git(repo, "worktree", "add", "-q", "-b", "later", later);
    for (const tree of [worktree, later]) {
      stage(tree, { "b.md": `${phone}\n` });
      const stopped = tryCommit(tree, gitleaks, "phone");
      expect(stopped.status).not.toBe(0);
      expect(stopped.out).toContain(`hook ran in ${tree}`);
      expect(stopped.out).toContain("b.md:1:phone");
      expect(stopped.head).toBe("hook mode");
    }
  });

  it("fails when the gitleaks program of GITLEAKS does not exist", () => {
    const result = install(withHook(), join(temp(), "no-gitleaks"));
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("install-hooks: FAILED");
  });

  it("fails outside a checkout with scripts/hooks/pre-commit", () => {
    const result = install(source(), stubGitleaks(0));
    expect(result.status).not.toBe(0);
    expect(result.out).toContain("scripts/hooks/pre-commit");
  });
});

describe("scripts/ci-local.sh and scripts/check.sh", () => {
  it("run the same privacy check", () => {
    const ciLocal = readFileSync(join(root, "scripts", "ci-local.sh"), "utf8");
    expect(ciLocal).toMatch(/^step "privacy[^"]*" privacy privacy$/m);
    expect(ciLocal).toContain("tools/privacy-check/src/cli.ts --tree");
    expect(readFileSync(join(root, "scripts", "check.sh"), "utf8")).toContain("step privacy npm run --silent privacy");
    const scripts = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.privacy).toBe("tsx tools/privacy-check/src/cli.ts");
  });
});

describe("the repository", () => {
  it("has no privacy finding in its tracked files", () => {
    const result = spawnSync(join(root, "node_modules", ".bin", "tsx"), [join(root, "tools", "privacy-check", "src", "cli.ts"), "--repo", root, "--tree"], { env: { PATH: process.env.PATH ?? "", PRIVACY_PEPPER: process.env.PRIVACY_PEPPER ?? "" }, encoding: "utf8" });
    expect(result.stdout).toContain("privacy: no findings");
    expect(result.status).toBe(0);
  });
});

describe("examples/", () => {
  const files = execFileSync("git", ["ls-files", "-z", "examples"], { cwd: root, encoding: "utf8" }).split("\0").filter((path) => path !== "");

  it("has every tracked file in the scope of the tree check, with no finding", () => {
    const allow = JSON.parse(readFileSync(join(root, ALLOWLIST_PATH), "utf8")) as { paths: string[] };
    expect(files).toContain("examples/README.md");
    expect(files.filter((path) => isSkipped(path, allow.paths))).toEqual([]);
    const lines: string[] = [];
    run(["--repo", root, "--tree"], { PATH: process.env.PATH ?? "", PRIVACY_PEPPER: process.env.PRIVACY_PEPPER ?? "" }, (line) => lines.push(line));
    expect(lines.filter((line) => line.startsWith("examples/"))).toEqual([]);
  });

  it("says in its README that all data is invented, and names the rule for example values", () => {
    const readme = readFileSync(join(root, "examples", "README.md"), "utf8");
    expect(readme).toContain("All data in `examples/` is invented");
    for (const kind of ["Family", "Children", "schools", "Accounts"]) expect(readme).toContain(kind);
    expect(readme).toContain("Use only the documented example values");
    expect(readme).toContain("tools/privacy-check/README.md");
    expect(readme).toContain("npm run privacy -- --tree");
  });
});
