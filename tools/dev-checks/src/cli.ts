#!/usr/bin/env node
// npm run crap:changed [-- --dry-run] [--base <ref>]: runs `npm run crap` only in the changed workspaces.
// --staged uses the staged files and no base (the pre-commit hook). --script <name> runs another script than `crap`.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { changedWorkspaces, expandWorkspaceGlobs, fileList, type Workspace } from "./changed.ts";

const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const baseAt = args.indexOf("--base");
const base = (baseAt >= 0 ? args[baseAt + 1] : undefined) ?? "origin/main";
const staged = args.includes("--staged");
const scriptAt = args.indexOf("--script");
const script = (scriptAt >= 0 ? args[scriptAt + 1] : undefined) ?? "crap";
const label = `${script}:${staged ? "staged" : "changed"}`;

const git = (...gitArgs: string[]) => execFileSync("git", gitArgs, { cwd: root, encoding: "utf8" });
const files = staged
  ? fileList(git("diff", "--cached", "--name-only"))
  : fileList(git("diff", "--name-only", `${base}...HEAD`), git("diff", "--name-only", "HEAD"), git("ls-files", "--others", "--exclude-standard"));

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as { name?: string; workspaces?: string[]; scripts?: Record<string, string> };
const rootPackage = existsSync(join(root, "package.json")) ? readJson(join(root, "package.json")) : {};
const dirs = expandWorkspaceGlobs(rootPackage.workspaces ?? [], (dir) => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)) : []));
const workspaces: Workspace[] = dirs
  .filter((dir) => existsSync(join(root, dir, "package.json")))
  .map((dir) => {
    const pkg = readJson(join(root, dir, "package.json"));
    return { name: pkg.name ?? dir, dir, scripts: pkg.scripts ?? {} };
  });

const selected = changedWorkspaces(files, workspaces, script);
console.log(`${label}: ${staged ? "staged files" : `base ${base}`}, ${files.length} changed file(s), workspaces: ${selected.map((w) => w.name).join(", ") || "none"}`);
if (dryRun) process.exit(0);
for (const workspace of selected) {
  const run = spawnSync("npm", ["run", script, "-w", workspace.name], { cwd: root, stdio: "inherit" });
  if (run.status !== 0) {
    console.error(`${label}: FAILED in ${workspace.name}`);
    process.exit(run.status ?? 1);
  }
}
