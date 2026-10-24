/**
 * The only code that knows how ActiveNow is read: a Rails login form with a CSRF token, a profile
 * picker, then the page of all lessons of the chosen profile. The secret values come from
 * `Runtime.secret`. They go only into the login form.
 */
import * as cheerio from "cheerio";
import { localDate, type Runtime } from "@automations/shared";
import { parseActiveNowEvents } from "./activenow-parse.ts";
import { ACTIVENOW_CACHE_TTL_MS, goodEntry, isFresh, keptEntry, loadEntry, nextFetchAt, saveEntry, type CacheEntry, type CacheStore } from "./activenow-cache.ts";
import { toSession } from "./activenow-sessions.ts";
import { createHttp, formBody, type Http, type HttpResult, type RequestOptions } from "./http.ts";
import { inWindow, type Session } from "./sessions.ts";
import { firstActivity, type ActivityTarget, type SessionSource, type SourceReading } from "./targets.ts";

interface Login {
  login: string;
  password: string;
}

const loginRejected = (html: string): boolean => html.includes('name="user[password]"');

const blockPage = (text: string): boolean => /Dostęp zablokowany|tymczasowo zablokowany/.test(text);

/**
 * Sends one request and checks its status. A 403 block page means ActiveNow blocks the network for about an
 * hour. The error ends the read of the Account, so no request is repeated: a retry makes the block longer.
 */
async function checked(http: Http, url: string, init?: RequestOptions): Promise<HttpResult> {
  const result = await http.request(url, init);
  if (result.status >= 200 && result.status < 400) return result;
  if (result.status === 403 && blockPage(result.text)) {
    throw new Error(
      "ActiveNow: HTTP 403, access temporarily blocked by ActiveNow (from the Kody network; clears within about 1 hour)",
    );
  }
  throw new Error(`ActiveNow: HTTP ${result.status} from ${new URL(url).pathname}`);
}

async function login(http: Http, origin: string, secrets: Login): Promise<string> {
  const form = await checked(http, `${origin}/users/sign_in`);
  const token = cheerio.load(form.text)("input[name=authenticity_token]").attr("value");
  if (!token) throw new Error("ActiveNow: login form not found (site changed?)");
  const after = await checked(http, `${origin}/users/sign_in`, {
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
  await checked(http, new URL($(link).attr("href") ?? "", origin).toString(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-csrf-token": token },
    body: formBody({ authenticity_token: token }),
  });
}

async function allLessons(http: Http, target: ActivityTarget, secrets: Login): Promise<string> {
  const { origin, group } = target.account;
  await chooseProfile(http, origin, await login(http, origin, secrets), group);
  const page = await checked(http, `${origin}/client_panel/all_events/events?around_now=true`, {
    headers: { "x-requested-with": "XMLHttpRequest" },
  });
  if (loginRejected(page.text)) throw new Error("ActiveNow: lessons page not available (login lost)");
  return page.text;
}

export interface ActiveNowOptions {
  /** Keeps the Sessions between runs. Without it every read fetches from ActiveNow. */
  store?: CacheStore;
  /** Time between two fetches of one Account. */
  ttlMs?: number;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function fetchSessions(runtime: Runtime, target: ActivityTarget, timezone: string): Promise<Session[]> {
  const activity = firstActivity(target);
  const secrets = {
    login: await runtime.secret(target.account.login_secret),
    password: await runtime.secret(target.account.password_secret),
  };
  const html = await allLessons(createHttp(runtime), target, secrets);
  return windowed(parseActiveNowEvents(html).map((event) => toSession(event, target.child, activity)), runtime, timezone);
}

function windowed(sessions: Session[], runtime: Runtime, timezone: string): Session[] {
  const today = localDate(runtime.now(), timezone);
  return sessions.filter((session) => inWindow(session, today)).sort((a, b) => a.start.localeCompare(b.start));
}

/** Gives the cached Sessions that still are in the window, with the error of the last attempt. */
function fromCache(runtime: Runtime, timezone: string, entry: CacheEntry | undefined, error?: string): SourceReading {
  const reading: SourceReading = {
    sessions: windowed(entry?.sessions ?? [], runtime, timezone),
    cached: entry !== undefined && entry.fetchedAt !== null,
    fetchedAt: entry?.fetchedAt ?? null,
  };
  return error === undefined ? reading : { ...reading, error };
}

async function attempt(
  runtime: Runtime,
  target: ActivityTarget,
  timezone: string,
  previous: CacheEntry | undefined,
): Promise<{ entry: CacheEntry; reading: SourceReading }> {
  const now = runtime.now();
  try {
    const sessions = await fetchSessions(runtime, target, timezone);
    if (sessions.length === 0) {
      const entry = keptEntry(previous, now, null);
      return { entry, reading: fromCache(runtime, timezone, entry) };
    }
    const entry = goodEntry(now, sessions);
    return { entry, reading: { sessions, cached: false, fetchedAt: entry.fetchedAt } };
  } catch (error) {
    const entry = keptEntry(previous, now, messageOf(error));
    return { entry, reading: fromCache(runtime, timezone, entry, messageOf(error)) };
  }
}

function logLine(runtime: Runtime, entry: CacheEntry, ttlMs: number, fetched: boolean): void {
  const next = nextFetchAt(entry, ttlMs).toISOString();
  if (!fetched) runtime.log("info", `activenow: cached (next fetch after ${next})`);
  else runtime.log("info", entry.error === null ? "activenow: fetched" : `activenow: fetch failed (next fetch after ${next})`);
}

/**
 * Reads the Sessions of one ActiveNow Account for the next 14 days. The `group` of the Account is the
 * name of the profile of the Child when one login serves several Children. With a store, ActiveNow is
 * fetched at most once in the TTL for the Account, counted from the last attempt. A failed or empty fetch
 * keeps the last good Sessions.
 */
export function createActiveNowSource(
  runtime: Runtime,
  target: ActivityTarget,
  timezone: string,
  options: ActiveNowOptions = {},
): SessionSource {
  const ttlMs = options.ttlMs ?? ACTIVENOW_CACHE_TTL_MS;
  const { store } = options;
  async function read(): Promise<SourceReading> {
    if (!store) return (await attempt(runtime, target, timezone, undefined)).reading;
    const previous = await loadEntry(store, target.account.id);
    if (previous && isFresh(previous, runtime.now(), ttlMs)) {
      logLine(runtime, previous, ttlMs, false);
      return fromCache(runtime, timezone, previous, previous.error ?? undefined);
    }
    const { entry, reading } = await attempt(runtime, target, timezone, previous);
    await saveEntry(store, target.account.id, entry);
    logLine(runtime, entry, ttlMs, true);
    return reading;
  }
  return {
    read,
    async sessions(): Promise<Session[]> {
      const reading = await read();
      if (reading.error !== undefined) throw new Error(reading.error);
      return reading.sessions;
    },
  };
}
