import * as host from "kody:runtime";
import type { LogLevel, Runtime, Schedule } from "./runtime.ts";

/** The part of `kody:runtime` that the Kody Runtime uses. */
export interface KodyHost {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  getSecret(name: string): Promise<string | undefined>;
  log(level: LogLevel, message: string): void;
  schedule(schedule: Schedule, task: () => Promise<void>): void;
}

export function createKodyRuntime(kody: KodyHost, now: () => Date = () => new Date()): Runtime {
  return {
    fetch: (input, init) => kody.fetch(input, init),
    secret: async (name) => {
      const value = await kody.getSecret(name);
      if (value === undefined || value === "") {
        throw new Error(`Secret ${name} is not set`);
      }
      return value;
    },
    now,
    log: (level, message) => kody.log(level, message),
    schedule: (schedule, task) => kody.schedule(schedule, task),
  };
}

/** Only the entry files of the packages import this module. This is the only file that imports `kody:runtime`. */
export const kodyRuntime: Runtime = createKodyRuntime(host);
