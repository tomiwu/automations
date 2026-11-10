#!/usr/bin/env node
// npm run crap:changed [-- --dry-run] [--base <ref>]: runs `npm run crap` only in the changed workspaces.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { changedWorkspaces, expandWorkspaceGlobs, fileList, type Workspace } from "./changed.ts";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const baseAt = args.indexOf("--base");
const base = (baseAt >= 0 ? args[baseAt + 1] : undefined) ?? "origin/main";

const git = (...gitArgs: string[]) => execFileSync("git", gitArgs, { cwd: root, encoding: "utf8" });
const files = fileList(
  git("diff", "--name-only", `${base}...HEAD`),
  git("diff", "--name-only", "HEAD"),
  git("ls-files", "--others", "--exclude-standard"),
);

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as { name?: string; workspaces?: string[]; scripts?: Record<string, string> };
const dirs = expandWorkspaceGlobs(readJson(join(root, "package.json")).workspaces ?? [], (dir) => readdirSync(join(root, dir)));
const workspaces: Workspace[] = dirs
  .filter((dir) => existsSync(join(root, dir, "package.json")))
  .map((dir) => {
    const pkg = readJson(join(root, dir, "package.json"));
    return { name: pkg.name ?? dir, dir, scripts: pkg.scripts ?? {} };
  });

const selected = changedWorkspaces(files, workspaces);
console.log(`crap:changed: base ${base}, ${files.length} changed file(s), workspaces: ${selected.map((w) => w.name).join(", ") || "none"}`);
if (dryRun) process.exit(0);
for (const workspace of selected) {
  const run = spawnSync("npm", ["run", "crap", "-w", workspace.name], { cwd: root, stdio: "inherit" });
  if (run.status !== 0) {
    console.error(`crap:changed: FAILED in ${workspace.name}`);
    process.exit(run.status ?? 1);
  }
}
