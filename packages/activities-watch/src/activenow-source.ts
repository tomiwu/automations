/**
 * The only code that knows how ActiveNow is read: a Rails login form with a CSRF token, a profile
 * picker, then the page of all lessons of the chosen profile. The secret values come from
 * `Runtime.secret`. They go only into the login form.
 */
import * as cheerio from "cheerio";
import { localDate, type Runtime } from "@automations/shared";
import { parseActiveNowEvents } from "./activenow-parse.ts";
import { toSession } from "./activenow-sessions.ts";
import { createHttp, formBody, type Http } from "./http.ts";
import { inWindow, type Session } from "./sessions.ts";
import { firstActivity, type ActivityTarget, type SessionSource } from "./targets.ts";

interface Login {
  login: string;
  password: string;
}

const loginRejected = (html: string): boolean => html.includes('name="user[password]"');

async function login(http: Http, origin: string, secrets: Login): Promise<string> {
  const form = await http.request(`${origin}/users/sign_in`);
  const token = cheerio.load(form.text)("input[name=authenticity_token]").attr("value");
  if (!token) throw new Error("ActiveNow: login form not found (site changed?)");
  const after = await http.request(`${origin}/users/sign_in`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", referer: `${origin}/users/sign_in` },
    body: formBody({ authenticity_token: token, "user[email]": secrets.login, "user[password]": secrets.password }),
  });
  if (loginRejected(after.text)) throw new Error("ActiveNow: login rejected (check credentials)");
  return after.text;
}

/** Opens the profile of the Child when the login shows a picker. A login with one Child goes straight to the panel. */
async function chooseProfile(http: Http, origin: string, html: string, profile: string | null): Promise<void> {
  const $ = cheerio.load(html);
  const links = $('a[href*="change_role"]').toArray();
  if (links.length === 0) return;
  const link = links.find((a) => profile !== null && $(a).text().includes(profile));
  if (!link) throw new Error("ActiveNow: profile of the Child not found (name changed?)");
  const token = $("meta[name=csrf-token]").attr("content") ?? "";
  await http.request(new URL($(link).attr("href") ?? "", origin).toString(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-csrf-token": token },
    body: formBody({ authenticity_token: token }),
  });
}

async function allLessons(http: Http, target: ActivityTarget, secrets: Login): Promise<string> {
  const { origin, group } = target.account;
  await chooseProfile(http, origin, await login(http, origin, secrets), group);
  const page = await http.request(`${origin}/client_panel/all_events/events?around_now=true`, {
    headers: { "x-requested-with": "XMLHttpRequest" },
  });
  if (page.status !== 200 || loginRejected(page.text)) {
    throw new Error(`ActiveNow: lessons page not available (HTTP ${page.status})`);
  }
  return page.text;
}

/**
 * Reads the Sessions of one ActiveNow Account for the next 14 days. The `group` of the Account is the
 * name of the profile of the Child when one login serves several Children.
 */
export function createActiveNowSource(runtime: Runtime, target: ActivityTarget, timezone: string): SessionSource {
  return {
    async sessions(): Promise<Session[]> {
      const activity = firstActivity(target);
      const secrets = {
        login: await runtime.secret(target.account.login_secret),
        password: await runtime.secret(target.account.password_secret),
      };
      const html = await allLessons(createHttp(runtime), target, secrets);
      const today = localDate(runtime.now(), timezone);
      return parseActiveNowEvents(html)
        .map((event) => toSession(event, target.child, activity))
        .filter((session) => inWindow(session, today))
        .sort((a, b) => a.start.localeCompare(b.start));
    },
  };
}
