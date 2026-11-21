// Vitest global setup of every workspace (issue #195): stop at once when the workspace packages
// resolve outside this checkout (a git worktree with a symlinked node_modules runs old code).
import { checkWorkspaceResolution } from "./tools/test-setup/src/workspace-check.ts";

export default function setup(): void {
  try {
    checkWorkspaceResolution(process.cwd());
  } catch (error) {
    // Print the line first: the error printer of vitest can fail on a global setup error.
    console.error(String(error instanceof Error ? error.message : error));
    throw error;
  }
}
