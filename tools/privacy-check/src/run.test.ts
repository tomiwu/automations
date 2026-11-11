import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { run } from "./run.ts";

// Every test uses a throwaway git repository with invented data. The positive samples are built at run time.
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const gitEnv = {
  PATH: process.env.PATH ?? "",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.com",
  GIT_COMMITTER_NAME: "Test Author",
  GIT_COMMITTER_EMAIL: "author@example.com",
};
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, env: gitEnv, encoding: "utf8" });

function repo(files: Record<string, string> = { "README.md": "Child One goes to Example School.\n" }): string {
  const dir = mkdtempSync(join(tmpdir(), "privacy-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  commit(dir, files, "first commit");
  return dir;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
}

function commit(dir: string, files: Record<string, string>, message: string): void {
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", message);
}

function check(dir: string, args: string[] = [], env: Record<string, string> = {}) {
  const lines: string[] = [];
  const status = run(["--repo", dir, ...args], { ...gitEnv, ...env }, (line) => lines.push(line));
  return { status, lines, out: lines.join("\n") };
}

const email = ["some.parent", "private-mail.net"].join("@");
const phone = ["+48", "601", "234", "567"].join(" ");
const tokenUrl = `https://api.service.example/feed?${["token", "a8f3k2m9x7q1w5e4"].join("=")}`;

describe("run: tree", () => {
  it("passes on a clean tree", () => {
    const { status, out } = check(repo());
    expect(status).toBe(0);
    expect(out).toMatch(/privacy: no findings \(tree: \d+ lines, 0 private word hashes\)/);
  });

  it.each([
    ["email", `mail: ${email}\n`],
    ["phone", `tel: ${phone}\n`],
    ["url-token", `${tokenUrl}\n`],
  ])("fails when a synthetic %s is added, and hides the value", (category, text) => {
    const dir = repo();
    commit(dir, { "docs/notes.md": `line one\n${text}` }, "add notes");
    const { status, lines, out } = check(dir);
    expect(status).toBe(1);
    expect(lines).toContain(`docs/notes.md:2:${category}`);
    expect(out).toContain("privacy: 1 finding(s) (values hidden)");
    expect(out).not.toContain(text.trim());
  });

  it("fails when a synthetic private word is added", () => {
    const dir = repo();
    write(dir, { ".privacy-denylist.txt": "Zorka\n" });
    expect(run(["hash", "--repo", dir], gitEnv, () => undefined)).toBe(0);
    const stored = readFileSync(join(dir, "privacy/denylist.hashes.json"), "utf8");
    expect(stored).not.toMatch(/zork/i);
    commit(dir, { "privacy/denylist.hashes.json": stored, ".gitignore": ".privacy-denylist.txt\n" }, "add hashes");
    expect(check(dir).status).toBe(0);

    commit(dir, { "src/a.ts": "// the lesson plan of Zorki\n" }, "add a comment");
    const { status, lines } = check(dir);
    expect(status).toBe(1);
    expect(lines).toContain("src/a.ts:1:private-word");
  });

  it("skips the paths and the values of the allowlist, and binary files", () => {
    const dir = repo();
    commit(dir, {
      "privacy/allowlist.json": JSON.stringify({ paths: ["vendor/"], values: [phone] }),
      "vendor/data.txt": `${email}\n`,
      "docs/a.md": `tel ${phone}\n`,
      "image.bin": `\u0000${email}\n`,
    }, "allowlist");
    expect(check(dir).status).toBe(0);
  });

  it("skips the private word check when the hashes need a pepper that is not set", () => {
    const dir = repo();
    write(dir, { "list.txt": "Zorka\n" });
    expect(run(["hash", "--repo", dir, "--in", join(dir, "list.txt")], { ...gitEnv, PRIVACY_PEPPER: "pepper-1" }, () => undefined)).toBe(0);
    rmSync(join(dir, "list.txt"));
    commit(dir, { "src/a.ts": "// Zorka\n" }, "add");
    const without = check(dir);
    expect(without.status).toBe(0);
    expect(without.out).toContain("privacy: WARNING PRIVACY_PEPPER is not set, the private word check did not run");
    expect(check(dir, [], { PRIVACY_PEPPER: "pepper-1" }).status).toBe(1);
    expect(check(dir, ["--require-words"]).status).toBe(1);
  });
});

describe("run: diff, staged and history", () => {
  it("--diff finds a line that the branch added", () => {
    const dir = repo();
    git(dir, "checkout", "-q", "-b", "feature");
    commit(dir, { "docs/b.md": `${email}\n` }, "add b");
    const { status, lines } = check(dir, ["--diff", "main"]);
    expect(status).toBe(1);
    expect(lines).toContain(`docs/b.md:1:email`);
    expect(check(dir, ["--diff", "HEAD"]).status).toBe(0);
  });

  it("--staged finds a staged line before the commit", () => {
    const dir = repo();
    expect(check(dir, ["--staged"]).status).toBe(0);
    write(dir, { "docs/c.md": `ok\n${phone}\n` });
    git(dir, "add", "-A");
    const { status, lines } = check(dir, ["--staged"]);
    expect(status).toBe(1);
    expect(lines).toContain("docs/c.md:2:phone");
  });

  it("--history finds a removed line, a commit message and an author address", () => {
    const dir = repo();
    commit(dir, { "docs/d.md": `${phone}\n` }, "add d");
    commit(dir, { "docs/d.md": "clean\n" }, `clean d, ask ${email}`);
    execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "empty"], { cwd: dir, env: { ...gitEnv, GIT_AUTHOR_EMAIL: email } });
    expect(check(dir).status).toBe(0);
    const { status, lines } = check(dir, ["--history"]);
    expect(status).toBe(1);
    expect(lines.filter((line) => /^commit [0-9a-f]+:docs\/d\.md:1:phone$/.test(line))).toHaveLength(1);
    expect(lines.filter((line) => /^commit [0-9a-f]+:metadata:\d+:email$/.test(line))).toHaveLength(2);
  });

  it("runs more than one mode in one call", () => {
    const { status, out } = check(repo(), ["--tree", "--history"]);
    expect(status).toBe(0);
    expect(out).toMatch(/tree: \d+ lines, history: \d+ lines/);
  });
});

describe("run: usage", () => {
  it("gives exit code 2 for an unknown argument", () => {
    const { status, out } = check(repo(), ["--what"]);
    expect(status).toBe(2);
    expect(out).toContain("privacy: unknown argument: --what");
  });

  it("gives exit code 2 when hash has no plain list", () => {
    const lines: string[] = [];
    expect(run(["hash", "--repo", repo()], gitEnv, (line) => lines.push(line))).toBe(2);
    expect(lines.join("\n")).toContain("privacy: no plain list");
  });

  it("hash reads the file of DENYLIST_FILE and prints only counts", () => {
    const dir = repo();
    const list = join(dir, "..", `list-${Date.now()}.txt`);
    writeFileSync(list, "Zorka\nBorzym Dom\n");
    dirs.push(list);
    const lines: string[] = [];
    expect(run(["hash", "--repo", dir], { ...gitEnv, DENYLIST_FILE: list }, (line) => lines.push(line))).toBe(0);
    expect(lines.join("\n")).toMatch(/privacy: wrote \d+ hashes of 2 entries to privacy\/denylist\.hashes\.json/);
    expect(lines.join("\n")).not.toMatch(/zork|borzym/i);
  });
});
