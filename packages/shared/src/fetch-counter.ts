import type { FetchFn } from "./runtime.ts";

export interface FetchCount {
  total: number;
  hosts: Record<string, number>;
}

export interface FetchCounter {
  /** Counts each call, then calls the wrapped fetch. A failed call counts too. */
  fetch: FetchFn;
  count(): FetchCount;
}

function hostOf(input: string): string {
  try {
    return new URL(input).host || "unknown";
  } catch {
    return "unknown";
  }
}

export function countFetches(wrapped: FetchFn): FetchCounter {
  const hosts: Record<string, number> = {};
  let total = 0;
  return {
    fetch: (input, init) => {
      const host = hostOf(input);
      hosts[host] = (hosts[host] ?? 0) + 1;
      total += 1;
      return wrapped(input, init);
    },
    count: () => ({ total, hosts: { ...hosts } }),
  };
}

/** Returns the log line of a count: `fetches total=N host=n ...`. The hosts are in alphabetical order. */
export function formatFetchCount({ total, hosts }: FetchCount): string {
  const parts = Object.keys(hosts)
    .sort()
    .map((host) => `${host}=${hosts[host]}`);
  return ["fetches", `total=${total}`, ...parts].join(" ");
}
