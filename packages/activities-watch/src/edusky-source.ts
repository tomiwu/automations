/**
 * The only code that knows how Edusky is read. Each organizer runs its own copy of the app at its
 * own address (`Account.origin`). A parent logs in with the OAuth2 password grant, finds the user ID,
 * then reads the calendar of everything the login can see. The secret values come from `Runtime.secret`.
 */
import { addDays, localDate, type Runtime } from "@automations/shared";
import { inGroup, toSession, type EduskyItem } from "./edusky-sessions.ts";
import { createHttp, formBody, type Http } from "./http.ts";
import { inWindow, WINDOW_DAYS, type Session } from "./sessions.ts";
import { firstActivity, type ActivityTarget, type SessionSource } from "./targets.ts";

/**
 * The name of the secret with the client secret of the Edusky web app. The web app sends the same
 * value for every organizer. It is not a credential of the Family, but the repository does not hold it.
 */
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

/** The OAuth2 error code of a failed grant (for example `invalid_grant` or `invalid_client`). It is never a secret. */
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

async function login(http: Http, origin: string, secrets: Login): Promise<string> {
  const config = await getJson<BaseConfig>(http, `${origin}/core/web/external/baseconfig`, "", "configuration");
  const grant = await http.request(config.OAuth2.accessTokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: formBody({
      grant_type: "password",
      client_id: config.OAuth2.clientId,
      client_secret: secrets.clientSecret,
      username: secrets.login,
      password: secrets.password,
    }),
  });
  const accessToken = grant.status === 200 ? tokenOf(grant.text) : undefined;
  if (!accessToken) {
    const code = grantError(grant.text);
    const detail = code ? `${code}: ${GRANT_HINTS[code] ?? "see the Edusky answer"}` : "check credentials";
    throw new Error(`Edusky: login rejected at ${new URL(origin).host} (HTTP ${grant.status}, ${detail})`);
  }
  return accessToken;
}

/** Reads the calendar of everything that the parent login can see, from `today` to the end of the window. */
async function calendar(http: Http, origin: string, secrets: Login, today: string): Promise<EduskyItem[]> {
  const accessToken = await login(http, origin, secrets);
  const api = `${origin}/core/web/api/`;
  const user = await getJson<{ id_userdata: number }>(http, `${api}common/users/auth`, accessToken, "user");
  const range = `dateFrom=${today}&dateTo=${addDays(today, WINDOW_DAYS)}`;
  return getJson<EduskyItem[]>(http, `${api}ext/calendaritemslist?idParent=${user.id_userdata}&${range}`, accessToken, "calendar");
}

/**
 * Reads the Sessions of one Edusky Account for the next 14 days. The `group` of the Account is the text
 * of the group name in the app. A login that serves several Children lists the groups of all of them.
 */
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
