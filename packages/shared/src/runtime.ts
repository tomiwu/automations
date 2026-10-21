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
  /** Returns the value of the secret with this name. Throws if the secret is missing. */
  secret(name: string): Promise<string>;
  now(): Date;
  log(level: LogLevel, message: string): void;
  /** Registers a task for a schedule. */
  schedule(schedule: Schedule, task: () => Promise<void>): void;
}
