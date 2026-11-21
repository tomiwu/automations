import { checkWorkspaceResolution } from "./tools/test-setup/src/workspace-check.ts";

export default function setup(): void {
  try {
    checkWorkspaceResolution(process.cwd());
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error));
    throw error;
  }
}
