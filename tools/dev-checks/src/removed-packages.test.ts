import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const KEPT = [
  ".gitignore",
  "docs/adr/0001-encrypted-credentials-in-supabase.md",
  "docs/adr/0004-rls-not-scoped-to-family.md",
  "docs/public-release-audit.md",
  "docs/supabase-setup.md",
  "supabase/migrations/0003_kradziejka.sql",
  "tools/admin/src/rekey.test.ts",
  "tools/dev-checks/src/removed-packages.test.ts",
  "tools/sql-tests/src/kradziejka.test.ts",
];

const git = (...args: string[]): string[] =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).split("\n").filter((line) => line !== "");

function filesNaming(word: string): string[] {
  try {
    return git("grep", "-il", "--", word);
  } catch {
    return [];
  }
}

function matrixPackages(): string[] {
  const workflow = readFileSync(join(root, ".github/workflows/deploy-kody.yml"), "utf8");
  const line = /^\s*package:\s*\[(.*)\]\s*$/m.exec(workflow);
  return (line?.[1] ?? "").split(",").map((name) => name.trim()).filter((name) => name !== "");
}

describe("the removed kradziejka package", () => {
  it("has no tracked file and is git-ignored", () => {
    expect(git("ls-files", "packages/kradziejka")).toEqual([]);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toMatch(/^packages\/kradziejka\/$/m);
  });

  it("is named only by the kept database files and the release docs", () => {
    expect(filesNaming("kradziejka").filter((path) => !KEPT.includes(path))).toEqual([]);
  });
});

describe("the deploy matrix of deploy-kody.yml", () => {
  it("names only package directories that exist", () => {
    const packages = matrixPackages();
    expect(packages.length).toBeGreaterThan(0);
    expect(packages.filter((name) => !existsSync(join(root, "packages", name, "package.json")))).toEqual([]);
    expect(packages).not.toContain("kradziejka");
  });
});
