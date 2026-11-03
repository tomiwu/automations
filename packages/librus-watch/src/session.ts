import type { Account, FetchFn, Runtime } from "@automations/shared";
import { formBody } from "@automations/shared";

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const PORTAL_URL = "https://portal.librus.pl/rodzina/synergia/loguj";
const PORTAL_REFERER = "https://portal.librus.pl/rodzina";
const API_ORIGIN = "https://api.librus.pl";
const MAX_REDIRECTS = 12;

/** Default time limit of one Librus request, in milliseconds. */
export const LIBRUS_TIMEOUT_MS = 25_000;

/** A Librus request that got no answer in time. */
export class LibrusTimeoutError extends Error {
  override name = "LibrusTimeoutError";
}

export interface SessionOptions {
  timeoutMs?: number;
}

interface Cookie {
  key: string;
  value: string;
  expired: boolean;
}

interface RequestOptions {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

function attributesOf(parts: string[]): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const part of parts) {
    const [name = "", ...value] = part.split("=");
    attributes[name.trim().toLowerCase()] = value.join("=").trim();
  }
  return attributes;
}

function parseSetCookie(header: string, host: string): Cookie {
  const [pair = "", ...rest] = header.split(";");
  const index = pair.indexOf("=");
  const attributes = attributesOf(rest);
  const domain = (attributes.domain ?? host).replace(/^\./, "");
  const value = pair.slice(index + 1);
  const expired = value === "deleted" || value === "" || attributes["max-age"] === "0";
  return { key: `${domain}|${attributes.path ?? "/"}|${pair.slice(0, index).trim()}`, value, expired };
}

/** A cookie jar keyed by domain, path and name. Librus sets one cookie name twice with different paths. */
class CookieJar {
  private cookies = new Map<string, string>();

  store(response: Response, host: string): void {
    for (const header of response.headers.getSetCookie()) {
      const cookie = parseSetCookie(header, host);
      if (cookie.expired) this.cookies.delete(cookie.key);
      else this.cookies.set(cookie.key, cookie.value);
    }
  }

  header(host: string, path: string): string {
    return [...this.cookies]
      .map(([key, value]) => ({ parts: key.split("|"), value }))
      .filter(({ parts }) => {
        const [domain = "", cookiePath = "/"] = parts;
        return (host === domain || host.endsWith(`.${domain}`)) && path.startsWith(cookiePath);
      })
      .map(({ parts, value }) => `${parts[2]}=${value}`)
      .join("; ");
  }
}

/** The anti-bot header of the login form: each character of a random number and the time, shifted by 20. */
function banner(random: number, now: number): string {
  const shift = (text: string) => [...text].map((c) => String.fromCharCode(c.charCodeAt(0) + 20)).join("");
  return `${shift(random.toString())}_${shift(now.toString())}`;
}

/** A logged-in HTTP session with Librus. The secrets come from the Runtime and are never logged. */
export class LibrusSession {
  private readonly jar = new CookieJar();
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(
    private readonly runtime: Runtime,
    private readonly account: Pick<Account, "origin" | "login_secret" | "password_secret">,
    options: SessionOptions = {},
  ) {
    this.fetchFn = runtime.fetch;
    this.timeoutMs = options.timeoutMs ?? LIBRUS_TIMEOUT_MS;
  }

  private async send(url: string, options: RequestOptions): Promise<Response> {
    const target = new URL(url);
    const response = await this.fetchFn(url, {
      method: options.method ?? "GET",
      body: options.body,
      redirect: "manual",
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: {
        cookie: this.jar.header(target.host, target.pathname),
        "user-agent": USER_AGENT,
        "accept-language": "pl-PL,pl;q=0.9",
        accept: "text/html,application/xhtml+xml,*/*",
        ...options.headers,
      },
    }).catch((error: unknown) => {
      const name = (error as { name?: unknown } | null)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new LibrusTimeoutError(`Librus: ${target.host}${target.pathname} timed out`);
      }
      throw error;
    });
    this.jar.store(response, target.host);
    return response;
  }

  /** Sends a request and follows redirects by hand, so each hop stores its cookies. */
  private async request(url: string, options: RequestOptions = {}): Promise<{ response: Response; url: string }> {
    let current = url;
    let next = options;
    for (let hop = 0; hop < MAX_REDIRECTS; hop += 1) {
      const response = await this.send(current, next);
      const location = response.headers.get("location");
      if (!(response.status >= 300 && response.status < 400 && location)) return { response, url: current };
      current = new URL(location, current).toString();
      next = { headers: options.headers };
    }
    throw new Error("Librus: too many redirects");
  }

  private async loginFormUrl(): Promise<string> {
    const portal = await this.request(PORTAL_URL, { headers: { referer: PORTAL_REFERER } });
    const source = loginIframeSource(await portal.response.text());
    if (!source) throw new Error("Librus: login iframe not found (portal changed?)");
    return (await this.request(source, { headers: { referer: "https://portal.librus.pl/" } })).url;
  }

  private async loginBody(): Promise<string> {
    const login = await this.runtime.secret(this.account.login_secret);
    const pass = await this.runtime.secret(this.account.password_secret);
    return formBody({ action: "login", login, pass });
  }

  private async submitLogin(formUrl: string): Promise<string> {
    const post = await this.request(formUrl, {
      method: "POST",
      headers: {
        referer: formUrl,
        origin: API_ORIGIN,
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        accept: "application/json",
        "x-baner": banner(Math.random(), this.runtime.now().getTime()),
      },
      body: await this.loginBody(),
    });
    return landingUrl(await post.response.text(), post.response.status, formUrl);
  }

  async login(): Promise<void> {
    const formUrl = await this.loginFormUrl();
    const landing = await this.submitLogin(formUrl);
    await this.request(landing, { headers: { referer: formUrl } });
  }

  /** Returns the HTML of a Synergia page. It throws when the session is not logged in. */
  async page(path: string): Promise<string> {
    const { response } = await this.request(new URL(path, this.account.origin).toString());
    const html = await response.text();
    if (/Brak dostępu/.test(html)) throw new Error("Librus: no access (session not logged in)");
    return html;
  }

  /** Returns the text of a Librus JSON API answer on the same login session. */
  async json(path: string): Promise<string> {
    const url = new URL(`/gateway/api/2.0/${path}`, this.account.origin).toString();
    const { response } = await this.request(url, { headers: { accept: "application/json" } });
    const text = await response.text();
    if (/Brak dostępu/.test(text)) throw new Error("Librus: no access (session not logged in)");
    if (!/^\s*[{[]/.test(text)) throw new Error(`Librus: unexpected response (HTTP ${response.status})`);
    return text;
  }
}

/** Finds the login iframe of the portal page: the old one has an id, the new one is told by its src. */
export function loginIframeSource(html: string): string | undefined {
  for (const [tag] of html.matchAll(/<iframe\b[^>]*>/g)) {
    const src = tag.match(/\ssrc="([^"]+)"/)?.[1];
    if (src && (/id="caLoginIframe"/.test(tag) || /\/loguj\//.test(src))) return src.replaceAll("&amp;", "&");
  }
  return undefined;
}

/** Reads the answer of the login form. It returns the landing URL, or throws. */
export function landingUrl(text: string, status: number, formUrl: string): string {
  let reply: { status?: string; goTo?: string };
  try {
    reply = JSON.parse(text) as typeof reply;
  } catch {
    throw new Error(`Librus: unexpected login response (HTTP ${status})`);
  }
  if (reply.status !== "ok" || !reply.goTo) throw new Error("Librus: login rejected (check credentials)");
  return new URL(reply.goTo, formUrl).toString();
}
