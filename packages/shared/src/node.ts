import { requireSecret, type LogLevel, type Runtime } from "./runtime.ts";

type Env = Readonly<Record<string, string | undefined>>;
type Sink = (line: string) => void;

export interface NodeRuntimeOptions {
  env?: Env;
  sink?: Sink;
}

/** Runtime for local runs. Secrets come from the environment. A scheduled task runs once at once. */
export function nodeRuntime(options: NodeRuntimeOptions = {}): Runtime {
  const env = options.env ?? (globalThis as { process?: { env: Env } }).process?.env ?? {};
  const sink = options.sink ?? ((line: string) => console.error(line));
  return {
    fetch: (input, init) => fetch(input, init),
    secret: async (name) => requireSecret(name, env[name]),
    now: () => new Date(),
    log: (level: LogLevel, message: string) => sink(`[${level}] ${message}`),
    schedule: (_schedule, task) => {
      void task();
    },
  };
}
