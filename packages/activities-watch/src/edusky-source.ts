import { addDays, localDate, type Runtime } from "@automations/shared";
import { inGroup, toSession, type EduskyItem } from "./edusky-sessions.ts";
import { createHttp, formBody, type Http } from "./http.ts";
import { inWindow, WINDOW_DAYS, type Session } from "./sessions.ts";
import { firstActivity, type ActivityTarget, type SessionSource } from "./targets.ts";

export const CLIENT_SECRET_NAME = "EDUSKY_CLIENT_SECRET";

interface Login {
  login: string;
  password: string;
  clientSecret: string;
}

interface BaseConfig {
  OAuth2: { clientId: string; accessTokenUri: string };
}

const authHeaders = (accessToken: string): Record<string, string> => ({
  accept: "application/json",
  ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
});

async function getJson<T>(http: Http, url: string, accessToken: string, what: string): Promise<T> {
  const response = await http.request(url, { headers: authHeaders(accessToken) });
  if (response.status !== 200) throw new Error(`Edusky ${what}: not available (HTTP ${response.status})`);
  try {
    return JSON.parse(response.text) as T;
  } catch {
    throw new Error(`Edusky ${what}: not JSON (site changed?)`);
  }
}

function tokenOf(text: string): string | undefined {
  try {
    return (JSON.parse(text) as { access_token?: string }).access_token;
  } catch {
    return undefined;
  }
}

export function grantError(text: string): string | undefined {
  try {
    const code = (JSON.parse(text) as { error?: unknown }).error;
    return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

const GRANT_HINTS: Record<string, string> = {
  invalid_grant: "wrong user name or password",
  invalid_client: "wrong EDUSKY_CLIENT_SECRET",
};

function loginFailure(host: string, grant: { status: number; text: string }): string {
  if (grant.status === 403 && /Just a moment/.test(grant.text)) {
    return `Edusky: login blocked by the Cloudflare challenge at ${host} (HTTP 403)`;
  }
  const code = grantError(grant.text);
  const detail = code ? `${code}: ${GRANT_HINTS[code] ?? "see the Edusky answer"}` : "check credentials";
  return `Edusky: login rejected at ${host} (HTTP ${grant.status}, ${detail})`;
}

async function login(http: Http, origin: string, secrets: Login): Promise<string> {
  const config = await getJson<BaseConfig>(http, `${origin}/core/web/external/baseconfig`, "", "configuration");
  // Cloudflare in front of Edusky challenges every POST to the token endpoint from a data-center
  // network (HTTP 403 "Just a moment..."), but lets a GET through. The token endpoint also takes
  // the grant as query parameters, and the Edusky web app itself sends its refresh grant that way.
  const query = formBody({
    grant_type: "password",
    client_id: config.OAuth2.clientId,
    client_secret: secrets.clientSecret,
    username: secrets.login,
    password: secrets.password,
  });
  const grant = await http.request(`${config.OAuth2.accessTokenUri}?${query}`, { headers: { accept: "application/json" } });
  const accessToken = grant.status === 200 ? tokenOf(grant.text) : undefined;
  if (!accessToken) throw new Error(loginFailure(new URL(origin).host, grant));
  return accessToken;
}

async function calendar(http: Http, origin: string, secrets: Login, today: string): Promise<EduskyItem[]> {
  const accessToken = await login(http, origin, secrets);
  const api = `${origin}/core/web/api/`;
  const user = await getJson<{ id_userdata: number }>(http, `${api}common/users/auth`, accessToken, "user");
  const range = `dateFrom=${today}&dateTo=${addDays(today, WINDOW_DAYS)}`;
  return getJson<EduskyItem[]>(http, `${api}ext/calendaritemslist?idParent=${user.id_userdata}&${range}`, accessToken, "calendar");
}

export function createEduskySource(runtime: Runtime, target: ActivityTarget, timezone: string): SessionSource {
  return {
    async sessions(): Promise<Session[]> {
      const { account, child } = target;
      const activity = firstActivity(target);
      const secrets: Login = {
        login: await runtime.secret(account.login_secret),
        password: await runtime.secret(account.password_secret),
        clientSecret: await runtime.secret(CLIENT_SECRET_NAME),
      };
      const today = localDate(runtime.now(), timezone);
      const items = await calendar(createHttp(runtime), account.origin, secrets, today);
      return items
        .filter((item) => inGroup(item, account.group))
        .map((item) => toSession(item, child, activity))
        .filter((session) => inWindow(session, today))
        .sort((a, b) => a.start.localeCompare(b.start));
    },
  };
}
