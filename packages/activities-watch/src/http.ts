import { createHttpSession, type Runtime } from "@automations/shared";

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const REQUEST_TIMEOUT_MS = 25_000;

export interface RequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

export interface HttpResult {
  status: number;
  text: string;
}

export interface Http {
  request(url: string, init?: RequestOptions): Promise<HttpResult>;
}

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
