import type { FetchFn } from "./runtime.ts";

const MAX_REDIRECTS = 10;

/** An HTTP session that keeps cookies between requests and follows redirects by hand. */
export interface HttpSession {
  fetch: FetchFn;
  /** Returns the Cookie header value for a URL, or an empty string. */
  cookieHeader(url: string): string;
}

function readSetCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function applyCookie(cookies: Map<string, string>, line: string): void {
  const pair = (line.split(";")[0] ?? "").trim();
  const index = pair.indexOf("=");
  if (index <= 0) return;
  const name = pair.slice(0, index);
  const value = pair.slice(index + 1);
  if (value === "" || /;\s*max-age=0/i.test(line)) cookies.delete(name);
  else cookies.set(name, value);
}

function storeCookies(jar: Map<string, Map<string, string>>, url: URL, response: Response): void {
  const cookies = jar.get(url.host) ?? new Map<string, string>();
  for (const line of readSetCookies(response)) applyCookie(cookies, line);
  jar.set(url.host, cookies);
}

function isRedirect(response: Response): boolean {
  return [301, 302, 303, 307, 308].includes(response.status) && response.headers.has("location");
}

function nextInit(init: RequestInit | undefined, status: number): RequestInit | undefined {
  if (status === 307 || status === 308) return init;
  return { ...init, method: "GET", body: undefined };
}

/** Creates a session on top of a fetch function. It sends and stores cookies for each host. */
export function createHttpSession(baseFetch: FetchFn): HttpSession {
  const jar = new Map<string, Map<string, string>>();

  const cookieHeader = (url: string): string =>
    [...(jar.get(new URL(url).host) ?? [])].map(([name, value]) => `${name}=${value}`).join("; ");

  const send = async (url: string, init: RequestInit | undefined, hops: number): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const cookie = cookieHeader(url);
    if (cookie) headers.set("cookie", cookie);
    const response = await baseFetch(url, { ...init, headers, redirect: "manual" });
    storeCookies(jar, new URL(url), response);
    if (!isRedirect(response)) return response;
    if (hops >= MAX_REDIRECTS) throw new Error(`Too many redirects: ${url}`);
    const target = new URL(response.headers.get("location") ?? "", url).toString();
    return send(target, nextInit(init, response.status), hops + 1);
  };

  return { fetch: (url, init) => send(url, init, 0), cookieHeader };
}
