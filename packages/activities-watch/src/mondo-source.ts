/**
 * The only code that knows how Mondo is read: the HTML login form of the parent panel, then the class
 * list of the Child on the page that the login opens. The secret values come from `Runtime.secret`.
 * They go only into the login form.
 */
import * as cheerio from "cheerio";
import { localDate, type Runtime } from "@automations/shared";
import { createHttp, formBody, type Http } from "./http.ts";
import { parseMondoEvents, type MondoEvent } from "./mondo-parse.ts";
import { inWindow, makeSession, type Session } from "./sessions.ts";
import { firstActivity, type ActivityTarget, type SessionSource } from "./targets.ts";

export interface Login {
  login: string;
  password: string;
}

const loginRejected = (html: string): boolean => html.includes('name="login[password]"');

/** Logs in with the form. Returns the page that the login opens: the parent panel with the child picker. */
export async function loginPage(http: Http, origin: string, secrets: Login): Promise<string> {
  const response = await http.request(`${origin}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", referer: `${origin}/login` },
    body: formBody({ "login[email]": secrets.login, "login[password]": secrets.password }),
  });
  if (response.status !== 200 || loginRejected(response.text)) {
    throw new Error(`Mondo: login rejected (HTTP ${response.status}, check credentials)`);
  }
  return response.text;
}

/**
 * The child picker has one `button` for each child, with the photo of the child at
 * `/parent/photo-children/<hash>`. A child that is not selected has an `onclick` to `/auth/set-student/<hash>`.
 */
export function childOf(html: string, name: string): { hash: string; selected: boolean } {
  const $ = cheerio.load(html);
  const button = $("button")
    .toArray()
    .map((element) => $(element))
    .find((candidate) => candidate.find('img[src*="/parent/photo-children/"]').length > 0 && candidate.text().includes(name));
  const hash = /photo-children\/([\w-]+)/.exec(button?.find("img").attr("src") ?? "")?.[1];
  if (!button || !hash) throw new Error(`Mondo: child ${name} not found in the parent panel`);
  return { hash, selected: !(button.attr("onclick") ?? "").includes("set-student") };
}

/** Logs in, selects the child and returns the class list of that child. */
async function panelPage(http: Http, origin: string, secrets: Login, name: string): Promise<string> {
  const child = childOf(await loginPage(http, origin, secrets), name);
  if (!child.selected) await http.request(`${origin}/auth/set-student/${child.hash}`);
  const response = await http.request(`${origin}/parent/xhr-activity/${child.hash}`, {
    headers: { "x-requested-with": "XMLHttpRequest" },
  });
  if (response.status !== 200) throw new Error(`Mondo: class list failed (HTTP ${response.status})`);
  return response.text;
}

/** Makes the Session of one class. The ID has the start of the class, so a new time is a new Item. */
function toSession(event: MondoEvent, target: ActivityTarget): Session {
  return makeSession(target.child, firstActivity(target), "mondo", {
    ...event,
    idDay: event.start.slice(0, 10),
    idTime: event.start.slice(11, 16),
  });
}

/**
 * Reads the Sessions of one Mondo Account for the next 14 days. The `group` of the Account is the text
 * of the Child in the child picker. An Account without a group uses the name of the Child.
 */
export function createMondoSource(runtime: Runtime, target: ActivityTarget, timezone: string): SessionSource {
  return {
    async sessions(): Promise<Session[]> {
      const { account, child } = target;
      firstActivity(target); // Fails before any request when the Account has no enabled Activity.
      const secrets = {
        login: await runtime.secret(account.login_secret),
        password: await runtime.secret(account.password_secret),
      };
      const html = await panelPage(createHttp(runtime), account.origin, secrets, account.group ?? child.name);
      const today = localDate(runtime.now(), timezone);
      return parseMondoEvents(html)
        .map((event) => toSession(event, target))
        .filter((session) => inWindow(session, today));
    },
  };
}
