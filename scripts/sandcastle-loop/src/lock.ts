// A box-wide lock around a step (for example one heavy compile at a time). It uses flock(1).
import { spawn } from "node:child_process";

export interface HeldLock {
  release(): void;
}

/** Takes the lock file with `flock`. It waits until the lock is free. Without a path it does nothing. */
export function acquireLock(path: string | undefined, command = "flock"): Promise<HeldLock> {
  if (!path) return Promise.resolve({ release: () => {} });
  return new Promise((resolve, reject) => {
    const child = spawn(command, [path, "sh", "-c", "echo locked; cat >/dev/null"], { stdio: ["pipe", "pipe", "inherit"] });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`flock ${path} ended with code ${code}`)));
    child.stdout.once("data", () => {
      child.removeAllListeners("exit");
      resolve({ release: () => child.stdin.end() });
    });
  });
}

/** Runs `step` while it holds the lock. */
export async function withLock<T>(path: string | undefined, step: () => Promise<T>, command?: string): Promise<T> {
  const lock = await acquireLock(path, command);
  try {
    return await step();
  } finally {
    lock.release();
  }
}
