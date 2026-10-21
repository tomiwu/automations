import type { LogLevel, Runtime, Schedule } from "./runtime.ts";

export interface FakeRuntime extends Runtime {
  readonly logs: { level: LogLevel; message: string }[];
  readonly scheduled: { schedule: Schedule; task: () => Promise<void> }[];
  readonly requests: { input: string; init?: RequestInit }[];
  setNow(date: Date): void;
}

export interface FakeRuntimeOptions {
  secrets?: Readonly<Record<string, string>>;
  now?: Date;
  respond?: (input: string, init?: RequestInit) => Response | Promise<Response>;
}

/** Runtime for tests. It uses no network and no clock. */
export function fakeRuntime(options: FakeRuntimeOptions = {}): FakeRuntime {
  let current = options.now ?? new Date("2025-01-01T00:00:00Z");
  const respond = options.respond ?? (() => new Response("", { status: 200 }));
  const logs: FakeRuntime["logs"] = [];
  const scheduled: FakeRuntime["scheduled"] = [];
  const requests: FakeRuntime["requests"] = [];
  return {
    logs,
    scheduled,
    requests,
    setNow: (date) => {
      current = date;
    },
    fetch: async (input, init) => {
      requests.push({ input, init });
      return respond(input, init);
    },
    secret: async (name) => {
      const value = options.secrets?.[name];
      if (value === undefined || value === "") {
        throw new Error(`Secret ${name} is not set`);
      }
      return value;
    },
    now: () => current,
    log: (level, message) => {
      logs.push({ level, message });
    },
    schedule: (schedule, task) => {
      scheduled.push({ schedule, task });
    },
  };
}
