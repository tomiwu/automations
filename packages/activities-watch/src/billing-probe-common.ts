import type { FetchCounter, Runtime } from "@automations/shared";
import { formatFetchCount, type FetchCount } from "@automations/shared";
import { redactPaths } from "./activenow-billing-redact.ts";

/** An error text with this mark stops the whole probe: the service blocks the box. */
const BLOCK_MARK = /HTTP 403/;

export function isBlockError(error: unknown): boolean {
  return error instanceof Error && BLOCK_MARK.test(error.message);
}

/** Gives a runtime that remembers the last address it fetched. The session follows redirects by hand. */
export function trackLastUrl(runtime: Runtime): { runtime: Runtime; lastUrl: () => string } {
  let last = "";
  const fetch: Runtime["fetch"] = (input, init) => {
    last = String(input);
    return runtime.fetch(input, init);
  };
  return { runtime: { ...runtime, fetch }, lastUrl: () => last };
}

/**
 * The text of an error for the result. Paths are redacted. A hidden text (the host, a name) becomes `<hidden>`,
 * the longest first.
 */
export function errorStatus(error: unknown, hidden: readonly (string | null | undefined)[]): string {
  const message = redactPaths(error instanceof Error ? error.message : String(error));
  const texts = hidden.filter((text): text is string => Boolean(text)).sort((a, b) => b.length - a.length);
  return texts.reduce((acc, text) => acc.split(text).join("<hidden>"), message);
}

export interface FetchDeps {
  runtime: Runtime;
  counter?: FetchCounter;
}

/** Logs the fetch count and adds it to the result, when the deps count fetches. */
export function withFetches<T extends object>(deps: FetchDeps, result: T): T & { fetches?: FetchCount } {
  if (!deps.counter) return result;
  const fetches = deps.counter.count();
  deps.runtime.log("info", formatFetchCount(fetches));
  return { ...result, fetches };
}
