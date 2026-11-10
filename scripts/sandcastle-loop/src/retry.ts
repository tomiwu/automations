// Retry of host commands (gh, git push). One network error (for example a TLS handshake timeout)
// must not stop the loop.

export type SyncExec = (cmd: string, args: string[]) => string;

export interface RetryOptions {
  /** Delays between the attempts, in milliseconds. The number of attempts is delays + 1. */
  delaysMs: number[];
  sleep?: (ms: number) => void;
  log?: (message: string) => void;
}

export const DEFAULT_RETRY_DELAYS = "5,15,45,90";

/** Parses `LOOP_RETRY_DELAYS`: seconds between the attempts, for example `5,15,45`. */
export function parseDelays(text: string): number[] {
  const delays = text.split(",").map((s) => s.trim()).filter(Boolean).map(Number);
  if (delays.some((d) => !Number.isFinite(d) || d < 0)) throw new Error(`Bad LOOP_RETRY_DELAYS: ${text}`);
  return delays.map((d) => d * 1000);
}

/** Blocks the thread for `ms` milliseconds. The host commands are synchronous. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Calls `run` again after each delay when it throws. Throws the last error. */
export function retrySync<T>(label: string, run: () => T, options: RetryOptions): T {
  const { delaysMs, sleep = sleepSync, log = () => {} } = options;
  for (let attempt = 0; ; attempt++) {
    try {
      return run();
    } catch (error) {
      const delay = delaysMs[attempt];
      if (delay === undefined) throw error;
      log(`RETRY ${label}: attempt ${attempt + 1} failed, retry in ${delay / 1000}s`);
      sleep(delay);
    }
  }
}

/** Wraps an exec: each call of a command in `commands` gets the retry. */
export function retryingExec(exec: SyncExec, commands: ReadonlySet<string>, options: RetryOptions): SyncExec {
  return (cmd, args) =>
    commands.has(cmd) ? retrySync(`${cmd} ${args.slice(0, 2).join(" ")}`, () => exec(cmd, args), options) : exec(cmd, args);
}
