import { createHttpSession, type Runtime } from "@automations/shared";

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Time limit of one request, in milliseconds. */
export const REQUEST_TIMEOUT_MS = 25_000;

export interface RequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

/** A finished request: the final status and the body text. */
export interface HttpResult {
  status: number;
  text: string;
}

/** A cookie-keeping client for one login at one organizer app. */
export interface Http {
  request(url: string, init?: RequestOptions): Promise<HttpResult>;
}

/** Creates a client on top of `Runtime.fetch`. Each client has its own cookies. */
export function createHttp(runtime: Runtime, timeoutMs: number = REQUEST_TIMEOUT_MS): Http {
  const session = createHttpSession(runtime.fetch);
  return {
    async request(url, init = {}) {
      const response = await session.fetch(url, {
        method: init.method ?? "GET",
        body: init.body,
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          "user-agent": USER_AGENT,
          "accept-language": "pl-PL,pl;q=0.9",
          accept: "text/html,application/xhtml+xml,*/*",
          ...init.headers,
        },
      });
      return { status: response.status, text: await response.text() };
    },
  };
}

export { formBody } from "@automations/shared";
