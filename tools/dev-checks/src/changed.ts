import { posix } from "node:path";

/** One npm workspace: its package name, its directory (relative to the root) and its scripts. */
export interface Workspace {
  name: string;
  dir: string;
  scripts: Record<string, string>;
}

/** Root files that every workspace uses. A change in one of them selects all workspaces. */
export const SHARED_FILES = ["package.json", "package-lock.json", "tsconfig.base.json"];

const inside = (file: string, dir: string): boolean => file.startsWith(`${dir}/`);

/**
 * The workspaces with the script `script` that a change touches. A changed file inside a workspace selects
 * it. A changed shared root file selects all of them. The order is the order of `workspaces`.
 */
export function changedWorkspaces(files: readonly string[], workspaces: readonly Workspace[], script = "crap"): Workspace[] {
  const withScript = workspaces.filter((workspace) => workspace.scripts[script] !== undefined);
  if (files.some((file) => SHARED_FILES.includes(file))) return withScript;
  return withScript.filter((workspace) => files.some((file) => inside(posix.normalize(file), workspace.dir)));
}

/** The directories of the `workspaces` globs of the root package.json. It knows `dir/*` and plain paths. */
export function expandWorkspaceGlobs(globs: readonly string[], listDir: (dir: string) => string[]): string[] {
  return globs.flatMap((glob) => {
    if (!glob.endsWith("/*")) return [glob];
    const parent = glob.slice(0, -2);
    return listDir(parent).sort().map((child) => `${parent}/${child}`);
  });
}

/** The file names of a `git diff --name-only` (or `ls-files`) output, without empty lines and repeats. */
export const fileList = (...outputs: string[]): string[] => [...new Set(outputs.join("\n").split("\n").map((line) => line.trim()).filter(Boolean))];
