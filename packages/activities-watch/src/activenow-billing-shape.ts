import * as cheerio from "cheerio";
import type { FetchCount, FetchCounter, Runtime } from "@automations/shared";
import { formatFetchCount } from "@automations/shared";
import { ACTIVE_NOW_BLOCK, blockPage, checked, isActiveNowBlock, openActiveNowPanel } from "./activenow-source.ts";
import {
  bodySkeleton,
  headSummary,
  isUpcomingMarkupAttr,
  maskIds,
  type HeadSummary,
  redactPaths,
  redactUrl,
  responseSkeleton,
} from "./activenow-billing-redact.ts";
import { checkKeys, inputObject } from "./exports.ts";
import { createHttp, type Http } from "./http.ts";
import { activityTargets, type ActivityTarget } from "./targets.ts";
import type { StorageAdapter } from "@automations/librus-data";

export interface BillingShapeDeps {
  runtime: Runtime;
  storage: StorageAdapter;
  familyId: string;
  counter?: FetchCounter;
}

export interface UpcomingProbe {
  source: "markup" | "javascript" | null;
  reason?: string;
  path?: string;
  status?: number;
  contentType?: string;
  skeleton?: string;
  upcomingParam?: string;
  jsSnippets?: string[];
}

export interface BillingShapeAccount {
  account: string;
  status?: string;
  billingLink: string | null;
  billingStatus?: number;
  /** The redacted path of the billing page after the redirects. */
  finalPath?: string;
  head?: HeadSummary;
  skeleton: string;
  upcoming?: UpcomingProbe;
}

export interface BillingShapeExport {
  accounts: BillingShapeAccount[];
  fetches?: FetchCount;
}

const SETTLEMENTS_INDEX = "/client_panel/settlements/index";
const UPCOMING_ACCEPT = "text/vnd.turbo-stream.html, text/html, application/json";
const KEYWORD = /\b(upcoming|fetch|url|src|visit)\b/gi;
const PATH_LITERAL = /["'](\/[^"']+)["']/g;

interface JsModuleState {
  url: string | null;
  source: string | null;
  status: number | null;
  error: string | null;
}

interface SharedProbeState {
  js: JsModuleState;
}

function billingHref(html: string, origin: string): string | null {
  const $ = cheerio.load(html);
  const link = $("a")
    .toArray()
    .find((node) => $(node).text().toLowerCase().includes("rozliczenia"));
  if (!link) return null;
  const href = $(link).attr("href");
  if (!href) return null;
  return new URL(href, origin).toString();
}

function trackLastUrl(runtime: Runtime): { runtime: Runtime; lastUrl: () => string } {
  let last = "";
  const fetch: Runtime["fetch"] = (input, init) => {
    last = String(input);
    return runtime.fetch(input, init);
  };
  return { runtime: { ...runtime, fetch }, lastUrl: () => last };
}

function pathOnly(raw: string): string {
  try {
    return new URL(raw, "https://example.invalid").pathname;
  } catch {
    return raw;
  }
}

function settlementsNodes($: cheerio.CheerioAPI) {
  const controller = $("[data-controller*=settlements]").toArray();
  const toggle = $("[data-client-panel-page-settlements-target=switch]").toArray();
  return [...controller, ...toggle];
}

function upcomingParamFlag(action: string, attrs: Record<string, string>): string | undefined {
  if (action.includes("upcoming")) return action;
  const flag = Object.entries(attrs).find(([name]) => name.endsWith("-upcoming-value"));
  return flag ? `${flag[0]}=${flag[1]}` : undefined;
}

function upcomingParam($: cheerio.CheerioAPI, nodes: ReturnType<typeof settlementsNodes>): string | undefined {
  for (const node of nodes) {
    const el = $(node);
    const value = upcomingParamFlag(el.attr("data-action") ?? "", el.attr() ?? {});
    if (value) return value;
  }
  return undefined;
}

function collectMarkupPath(value: string, paths: Set<string>): void {
  if (!value.startsWith("/")) return;
  if (pathOnly(value) === SETTLEMENTS_INDEX && !value.includes("upcoming")) return;
  paths.add(value);
}

function markupPaths($: cheerio.CheerioAPI): { paths: string[]; param?: string } {
  const nodes = settlementsNodes($);
  const paths = new Set<string>();
  for (const node of nodes) {
    const attrs = $(node).attr() ?? {};
    for (const [name, value] of Object.entries(attrs)) {
      if (isUpcomingMarkupAttr(name)) collectMarkupPath(value, paths);
    }
  }
  return { paths: [...paths], param: upcomingParam($, nodes) };
}

function importmapSettlementsHref(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { imports?: Record<string, string> };
    const key = Object.keys(parsed.imports ?? {}).find((name) => name.includes("settlements"));
    return key ? (parsed.imports?.[key] ?? null) : null;
  } catch {
    return null;
  }
}

function rawSettlementsModuleHref(html: string): string | null {
  const $ = cheerio.load(html);
  const fromMap = importmapSettlementsHref($('head script[type="importmap"]').first().text().trim());
  if (fromMap) return fromMap;
  return (
    $("head link[rel=modulepreload]")
      .toArray()
      .map((node) => $(node).attr("href"))
      .find((href) => href?.includes("settlements")) ?? null
  );
}

function redactedSnippets(source: string): string[] {
  const hits: string[] = [];
  for (const match of source.matchAll(KEYWORD)) {
    const index = match.index ?? 0;
    const start = Math.max(0, index - 120);
    const end = Math.min(source.length, index + 280);
    hits.push(maskIds(source.slice(start, end)));
    if (hits.length >= 3) break;
  }
  return hits;
}

function literalsFromJs(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(PATH_LITERAL)) {
    const lit = match[1];
    if (lit) found.add(lit);
  }
  return [...found];
}

function solePath(paths: string[]): string | null {
  return paths.length === 1 ? (paths[0] ?? null) : null;
}

function chooseJsUpcoming(paths: string[]): string | null {
  const upcomingOnly = solePath(paths.filter((p) => p.includes("upcoming")));
  if (upcomingOnly) return upcomingOnly;
  const nonIndexOnly = solePath(paths.filter((p) => pathOnly(p) !== SETTLEMENTS_INDEX));
  if (nonIndexOnly) return nonIndexOnly;
  const only = solePath(paths);
  return only?.includes("?") ? only : null;
}

function moduleUrl(html: string, origin: string, shared: SharedProbeState): string | null {
  if (shared.js.url) return shared.js.url;
  const href = rawSettlementsModuleHref(html);
  shared.js.url = href ? new URL(href, origin).toString() : null;
  return shared.js.url;
}

async function readModuleSource(http: Http, url: string, shared: JsModuleState): Promise<void> {
  const result = await http.request(url);
  shared.status = result.status;
  if (result.status < 200 || result.status >= 300) {
    shared.error = `ActiveNow: HTTP ${result.status} from settlements JavaScript module`;
    return;
  }
  shared.source = result.text;
}

async function loadSettlementsModule(
  http: Http,
  origin: string,
  html: string,
  shared: SharedProbeState,
): Promise<JsModuleState> {
  if (shared.js.source !== null || shared.js.error !== null) return shared.js;
  const url = moduleUrl(html, origin, shared);
  if (!url) {
    shared.js.error = "settlements JavaScript module not found in head";
    return shared.js;
  }
  await readModuleSource(http, url, shared.js);
  return shared.js;
}

function upcomingFromJs(source: string): { path: string | null; snippets: string[]; reason?: string } {
  const paths = literalsFromJs(source);
  const path = chooseJsUpcoming(paths);
  const snippets = redactedSnippets(source);
  if (!path) {
    return { path: null, snippets, reason: paths.length === 0 ? "no path literals in module" : "ambiguous path literals in module" };
  }
  return { path, snippets };
}

function guessContentType(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "application/json";
  if (trimmed.includes("turbo-stream")) return "text/vnd.turbo-stream.html";
  return "text/html";
}

async function fetchUpcoming(http: Http, origin: string, rawPath: string): Promise<Omit<UpcomingProbe, "source">> {
  const url = new URL(rawPath, origin).toString();
  const page = await http.request(url, {
    headers: { accept: UPCOMING_ACCEPT, "x-requested-with": "XMLHttpRequest" },
  });
  if (page.status === 403 && blockPage(page.text)) throw new Error(ACTIVE_NOW_BLOCK);
  const contentType = guessContentType(page.text);
  return {
    path: redactUrl(rawPath),
    status: page.status,
    contentType,
    skeleton: responseSkeleton(page.text, contentType),
  };
}

async function resolveFromJs(http: Http, origin: string, html: string, shared: SharedProbeState): Promise<UpcomingProbe> {
  const module = await loadSettlementsModule(http, origin, html, shared);
  if (module.error) return { source: null, reason: module.error };
  if (!module.source) return { source: null, reason: "settlements JavaScript module empty" };
  const fromJs = upcomingFromJs(module.source);
  if (!fromJs.path) return { source: null, reason: fromJs.reason, jsSnippets: fromJs.snippets };
  const body = await fetchUpcoming(http, origin, fromJs.path);
  return { source: "javascript", jsSnippets: fromJs.snippets, ...body };
}

async function resolveUpcoming(http: Http, origin: string, html: string, shared: SharedProbeState): Promise<UpcomingProbe> {
  const markup = markupPaths(cheerio.load(html));
  const soleMarkup = markup.paths.length === 1 ? markup.paths[0]! : null;
  if (soleMarkup) {
    const body = await fetchUpcoming(http, origin, soleMarkup);
    return { source: "markup", upcomingParam: markup.param, ...body };
  }
  const fromJs = await resolveFromJs(http, origin, html, shared);
  if (fromJs.source !== null) return fromJs;
  if (markup.paths.length > 1) return { source: null, reason: "ambiguous upcoming paths in markup" };
  return fromJs;
}

async function probeAccount(
  target: ActivityTarget,
  runtime: Runtime,
  shared: SharedProbeState,
): Promise<BillingShapeAccount> {
  const tracked = trackLastUrl(runtime);
  const http = createHttp(tracked.runtime);
  const { origin, group, login_secret, password_secret } = target.account;
  const secrets = { login: await runtime.secret(login_secret), password: await runtime.secret(password_secret) };
  const panel = await openActiveNowPanel(http, origin, secrets, group);
  const billing = billingHref(panel, origin);
  if (billing === null) {
    return { account: "", billingLink: null, skeleton: bodySkeleton(panel) };
  }
  const page = await checked(http, billing);
  const head = headSummary(page.text);
  const upcoming = await resolveUpcoming(http, origin, page.text, shared);
  return {
    account: "",
    billingLink: redactUrl(billing),
    billingStatus: page.status,
    finalPath: redactUrl(tracked.lastUrl()),
    head,
    skeleton: bodySkeleton(page.text),
    upcoming,
  };
}

function withFetches(deps: BillingShapeDeps, result: BillingShapeExport): BillingShapeExport {
  if (!deps.counter) return result;
  const fetches = deps.counter.count();
  deps.runtime.log("info", formatFetchCount(fetches));
  return { ...result, fetches };
}

function freshSharedState(): SharedProbeState {
  return { js: { url: null, source: null, status: null, error: null } };
}

/** Read-only probe of the ActiveNow billing page shape. It takes no input. */
export async function activenowBillingShapeExport(deps: BillingShapeDeps, input: unknown = {}): Promise<BillingShapeExport> {
  checkKeys(inputObject(input), []);
  const config = await deps.storage.loadConfig(deps.familyId);
  const targets = activityTargets(config).targets.filter((target) => target.account.service === "activenow");
  const shared = freshSharedState();
  const accounts: BillingShapeAccount[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]!;
    const label = `account ${index + 1}`;
    try {
      const row = await probeAccount(target, deps.runtime, shared);
      accounts.push({ ...row, account: label });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      accounts.push({ account: label, status: redactPaths(message), billingLink: null, skeleton: "" });
      if (isActiveNowBlock(error)) break;
    }
  }
  return withFetches(deps, { accounts });
}