import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

/**
 * A check for the tests: the workspace packages must resolve inside the checkout that runs the tests.
 * In a git worktree with a symlinked `node_modules`, `@automations/shared` and the other packages resolve
 * to the main checkout, so the tests run old code. The root `vitest.global-setup.ts` calls this check.
 */

export const OUTSIDE_MESSAGE = "workspace packages resolve outside this checkout: run npm ci here";

/** True when `path` is `root` or inside it. */
export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** The first directory from `start` up to `/` for which `test` is true, or null. */
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

/**
 * Throws `OUTSIDE_MESSAGE` when the package `name`, as Node finds it from `start`, is outside the workspace
 * root of `start` (after symlinks). It does nothing outside a workspace or when the package is not installed.
 */
export function checkWorkspaceResolution(start: string, name = "@automations/shared"): void {
  const root = findUp(start, hasWorkspaces);
  const holder = findUp(start, (dir) => existsSync(join(dir, "node_modules", name)));
  if (root === null || holder === null) return;
  if (!isInside(realpathSync(root), realpathSync(join(holder, "node_modules", name)))) throw new Error(OUTSIDE_MESSAGE);
}
