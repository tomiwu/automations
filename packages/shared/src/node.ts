import type { LogLevel, Runtime } from "./runtime.ts";

type Env = Readonly<Record<string, string | undefined>>;
type Sink = (line: string) => void;

export interface NodeRuntimeOptions {
  env?: Env;
  sink?: Sink;
}

/** Runtime for local runs. Secrets come from the environment. A scheduled task runs once at once. */
export function nodeRuntime(options: NodeRuntimeOptions = {}): Runtime {
  const env = options.env ?? process.env;
  const sink = options.sink ?? ((line: string) => console.error(line));
  return {
    fetch: (input, init) => fetch(input, init),
    secret: async (name) => {
      const value = env[name];
      if (value === undefined || value === "") {
        throw new Error(`Secret ${name} is not set`);
      }
      return value;
    },
    now: () => new Date(),
    log: (level: LogLevel, message: string) => sink(`[${level}] ${message}`),
    schedule: (_schedule, task) => {
      void task();
    },
  };
}
