import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pepperFromDotenv, resolvePepper } from "./pepper.ts";
import { run } from "./run.ts";

// Throwaway git repositories with invented words and synthetic peppers only.
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
const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, env: gitEnv, encoding: "utf8" });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pepper-"));
  dirs.push(dir);
  return dir;
}

function repo(files: Record<string, string>): string {
  const dir = tempDir();
  git(dir, "init", "-q", "-b", "main");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first commit");
  return dir;
}

function worktreeOf(dir: string): string {
  const tree = join(tempDir(), "tree");
  git(dir, "worktree", "add", "-q", "--detach", tree);
  return tree;
}

describe("pepperFromDotenv", () => {
  it("reads the PRIVACY_PEPPER line, with export, quotes and a comment", () => {
    expect(pepperFromDotenv("A=1\nPRIVACY_PEPPER=plain-1\n")).toBe("plain-1");
    expect(pepperFromDotenv("export PRIVACY_PEPPER = \"quoted 2\"\n")).toBe("quoted 2");
    expect(pepperFromDotenv("PRIVACY_PEPPER='single-3'\r\n")).toBe("single-3");
    expect(pepperFromDotenv("PRIVACY_PEPPER=value-4 # a comment\n")).toBe("value-4");
  });

  it("gives an empty value without the line", () => {
    expect(pepperFromDotenv("")).toBe("");
    expect(pepperFromDotenv("# PRIVACY_PEPPER=commented\nOTHER=1\n")).toBe("");
  });
});

describe("resolvePepper", () => {
  it("takes the environment first, then PRIVACY_PEPPER_FILE, then the .env of the repository", () => {
    const dir = repo({ "README.md": "x\n" });
    writeFileSync(join(dir, ".env"), "PRIVACY_PEPPER=from-dotenv\n");
    const file = join(tempDir(), "pepper");
    writeFileSync(file, "from-file\n");
    expect(resolvePepper({ PRIVACY_PEPPER: "from-env", PRIVACY_PEPPER_FILE: file }, dir)).toBe("from-env");
    expect(resolvePepper({ PRIVACY_PEPPER_FILE: file }, dir)).toBe("from-file");
    expect(resolvePepper({}, dir)).toBe("from-dotenv");
  });

  it("takes the .env of the main checkout for a worktree, and of the extra directories", () => {
    const main = repo({ "README.md": "x\n" });
    writeFileSync(join(main, ".env"), "PRIVACY_PEPPER=from-main\n");
    expect(resolvePepper({}, worktreeOf(main))).toBe("from-main");
    const other = tempDir();
    expect(resolvePepper({}, other)).toBe("");
    expect(resolvePepper({}, other, [main])).toBe("from-main");
  });
});

describe("run with the pepper in a .env", () => {
  it("finds a synthetic private word in a worktree and never prints the pepper", () => {
    const pepper = "synthetic-pepper-5f3a";
    const main = repo({ "README.md": "Child One goes to Example School.\n" });
    writeFileSync(join(main, "list.txt"), "Zorka\n");
    expect(run(["hash", "--repo", main, "--in", join(main, "list.txt")], { ...gitEnv, PRIVACY_PEPPER: pepper }, () => undefined)).toBe(0);
    expect(readFileSync(join(main, "privacy/denylist.hashes.json"), "utf8")).not.toContain(pepper);
    rmSync(join(main, "list.txt"));
    writeFileSync(join(main, ".gitignore"), ".env\n");
    writeFileSync(join(main, ".env"), `PRIVACY_PEPPER=${pepper}\n`);
    writeFileSync(join(main, "notes.md"), "// the plan of Zorki\n");
    git(main, "add", "-A");
    git(main, "commit", "-q", "-m", "add");
    const lines: string[] = [];
    const status = run(["--repo", worktreeOf(main), "--tree", "--require-words"], gitEnv, (line) => lines.push(line));
    expect(status).toBe(1);
    expect(lines).toContain("notes.md:1:private-word");
    expect(lines.join("\n")).not.toContain(pepper);
  });
});
