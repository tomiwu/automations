// Retry of host commands (gh, git push). One network error (for example a TLS handshake timeout)
// must not stop the loop. A permanent error (404, 401, "Could not resolve to a PullRequest") fails at once.

export type SyncExec = (cmd: string, args: string[]) => string;

export interface RetryOptions {
  /** Delays between the attempts, in milliseconds. The number of attempts is delays + 1. */
  delaysMs: number[];
  sleep?: (ms: number) => void;
  log?: (message: string) => void;
  /** The error texts that are transient. Only these are retried. The default is `DEFAULT_TRANSIENT`. */
  transient?: readonly RegExp[];
}

/**
 * The transient failures of gh and git: network resets, EOF, TLS, timeouts, DNS, HTTP 5xx, HTTP 429 and
 * the GitHub secondary rate limit. Anything else is permanent. `LOOP_RETRY_TRANSIENT` adds one pattern.
 */
export const DEFAULT_TRANSIENT: readonly RegExp[] = [
  /connection reset|ECONNRESET|broken pipe/i,
  /unexpected EOF|early EOF|remote end hung up/i,
  /TLS handshake|SSL_ERROR|SSL_connect/i,
  /timed out|timeout|ETIMEDOUT/i,
  /Could not resolve host|EAI_AGAIN|temporary failure in name resolution/i,
  /HTTP 5\d\d|returned error: 5\d\d|\b50[0234] (Internal|Bad Gateway|Service Unavailable|Gateway Timeout)/i,
  /HTTP 429|returned error: 429|too many requests/i,
  /secondary rate limit/i,
];

/** The transient patterns: the default list plus the regex of `LOOP_RETRY_TRANSIENT` (case-insensitive). */
export function parseTransient(extra: string | undefined): RegExp[] {
  if (!extra) return [...DEFAULT_TRANSIENT];
  try {
    return [...DEFAULT_TRANSIENT, new RegExp(extra, "i")];
  } catch {
    throw new Error(`Bad LOOP_RETRY_TRANSIENT: ${extra}`);
  }
}

/** The message, stderr and stdout of an error (an `execFileSync` error carries the last two). */
export function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const { stderr, stdout } = error as Error & { stderr?: unknown; stdout?: unknown };
  return [error.message, stderr, stdout].filter((part) => typeof part === "string" || Buffer.isBuffer(part)).map(String).join("\n");
}

export const isTransient = (error: unknown, patterns: readonly RegExp[] = DEFAULT_TRANSIENT): boolean => {
  const text = errorText(error);
  return patterns.some((pattern) => pattern.test(text));
};

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

/**
 * Calls `run` again after each delay when it throws a transient error. A permanent error is thrown at once.
 * Throws the last error.
 */
export function retrySync<T>(label: string, run: () => T, options: RetryOptions): T {
  const { delaysMs, sleep = sleepSync, log = () => {}, transient = DEFAULT_TRANSIENT } = options;
  for (let attempt = 0; ; attempt++) {
    try {
      return run();
    } catch (error) {
      const delay = isTransient(error, transient) ? delaysMs[attempt] : undefined;
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
