import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// Tests of scripts/clean-publish.sh, scripts/hooks/pre-commit and the privacy step of scripts/ci-local.sh.
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

function commit(repo: string, files: Record<string, string>, message: string): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, "add", "-A");
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

describe("scripts/hooks/pre-commit", () => {
  it("stops a commit with a staged finding and lets a clean commit pass", () => {
    const repo = source();
    git(repo, "config", "core.hooksPath", join(root, "scripts", "hooks"));
    writeFileSync(join(repo, "a.md"), "Child Two\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "clean");

    writeFileSync(join(repo, "b.md"), `${phone}\n`);
    git(repo, "add", "-A");
    const result = spawnSync("git", ["commit", "-q", "-m", "phone"], { cwd: repo, env, encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("b.md:1:phone");
    expect(git(repo, "log", "-1", "--format=%s").trim()).toBe("clean");
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
