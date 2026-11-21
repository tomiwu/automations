import { posix } from "node:path";

export interface Workspace {
  name: string;
  dir: string;
  scripts: Record<string, string>;
}

export const SHARED_FILES = ["package.json", "package-lock.json", "tsconfig.base.json"];

const inside = (file: string, dir: string): boolean => file.startsWith(`${dir}/`);

export function changedWorkspaces(files: readonly string[], workspaces: readonly Workspace[], script = "crap"): Workspace[] {
  const withScript = workspaces.filter((workspace) => workspace.scripts[script] !== undefined);
  if (files.some((file) => SHARED_FILES.includes(file))) return withScript;
  return withScript.filter((workspace) => files.some((file) => inside(posix.normalize(file), workspace.dir)));
}

export function expandWorkspaceGlobs(globs: readonly string[], listDir: (dir: string) => string[]): string[] {
  return globs.flatMap((glob) => {
    if (!glob.endsWith("/*")) return [glob];
    const parent = glob.slice(0, -2);
    return listDir(parent).sort().map((child) => `${parent}/${child}`);
  });
}

export const fileList = (...outputs: string[]): string[] => [...new Set(outputs.join("\n").split("\n").map((line) => line.trim()).filter(Boolean))];
