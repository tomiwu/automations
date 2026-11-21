import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

export const OUTSIDE_MESSAGE = "workspace packages resolve outside this checkout: run npm ci here";

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function findUp(start: string, test: (dir: string) => boolean): string | null {
  for (let dir = start; ; dir = dirname(dir)) {
    if (test(dir)) return dir;
    if (dirname(dir) === dir) return null;
  }
}

const hasWorkspaces = (dir: string): boolean => {
  const file = join(dir, "package.json");
  return existsSync(file) && Array.isArray((JSON.parse(readFileSync(file, "utf8")) as { workspaces?: unknown }).workspaces);
};

export function checkWorkspaceResolution(start: string, name = "@automations/shared"): void {
  const root = findUp(start, hasWorkspaces);
  const holder = findUp(start, (dir) => existsSync(join(dir, "node_modules", name)));
  if (root === null || holder === null) return;
  if (!isInside(realpathSync(root), realpathSync(join(holder, "node_modules", name)))) throw new Error(OUTSIDE_MESSAGE);
}
