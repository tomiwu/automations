export type LogLevel = "debug" | "info" | "warn" | "error";

/** When a job runs: a cron expression and an IANA time zone. */
export interface Schedule {
  readonly cron: string;
  readonly timezone: string;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

/** The platform services that the watchers use. Watcher code imports only this interface. */
export interface Runtime {
  fetch: FetchFn;
  /**
   * Returns the value of the service credential with this name (for example `accounts.login_secret`). Locally it
   * comes from the environment; on Kody it is decrypted from the `credentials` table. Use it only in a login
   * request: never put it in a URL, a log or a message. Throws if it is missing.
   */
  secret(name: string): Promise<string>;
  now(): Date;
  log(level: LogLevel, message: string): void;
  /** Registers a task for a schedule. */
  schedule(schedule: Schedule, task: () => Promise<void>): void;
}

/** Returns the secret value. Throws if the value is missing or empty. */
export function requireSecret(name: string, value: string | undefined): string {
  if (value === undefined || value === "") {
    throw new Error(`Secret ${name} is not set`);
  }
  return value;
}
