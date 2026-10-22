import { saveBotEdit, type RegisterDeps } from "./register.ts";
import type { BotRecord } from "./registry.ts";

export interface AdminDeps extends RegisterDeps {
  adminToken: string;
  allowlist: readonly string[];
  saveAllowlist(ids: unknown): Promise<string[]>;
}

const COOKIE = "kradziejka_admin";
const HANDLERS: Record<string, (request: Request, deps: AdminDeps, base: string) => Promise<Response>> = {
  "GET /": listPage,
  "GET /login": loginPage,
  "POST /login": login,
  "POST /logout": logout,
  "GET /new": newPage,
  "GET /edit": editPage,
  "POST /save": save,
  "POST /allowlist": saveList,
};

/** Serves the registry admin page. The page requires the admin token from ./configure. */
export async function handleAdmin(request: Request, deps: AdminDeps, base: string): Promise<Response> {
  const key = `${request.method} ${routePath(request.url, base)}`;
  const handler = HANDLERS[key];
  if (!handler) return textResponse("Not found.", 404);
  if (isPublic(key)) return handler(request, deps, base);
  if (!(await authorized(request, deps.adminToken))) return loginPage(request, deps, base);
  return handler(request, deps, base);
}

function isPublic(key: string): boolean {
  return key === "GET /login" || key === "POST /login" || key === "POST /logout";
}

export function routePath(url: string, base: string): string {
  const path = trimSlash(new URL(url).pathname);
  if (!base || !path.startsWith(base)) return path;
  return trimSlash(path.slice(base.length));
}

function trimSlash(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

export async function authorized(request: Request, adminToken: string): Promise<boolean> {
  const cookie = cookieValue(request.headers.get("cookie"), COOKIE);
  if (cookie.length !== 64) return false;
  return sameText(cookie, await tokenDigest(adminToken));
}

export function cookieValue(header: string | null, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const value = pairValue(part, name);
    if (value !== null) return value;
  }
  return "";
}

function pairValue(part: string, name: string): string | null {
  const text = part.trim();
  const eq = text.indexOf("=");
  if (eq < 0 || text.slice(0, eq) !== name) return null;
  return text.slice(eq + 1);
}

export async function tokenDigest(token: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return toHex(bytes);
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function sameText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

async function login(request: Request, deps: AdminDeps, base: string): Promise<Response> {
  const fields = await formFields(request);
  const digest = await tokenDigest(fields.token ?? "");
  const expected = await tokenDigest(deps.adminToken);
  if (!sameText(digest, expected)) return loginPage(request, deps, base, "The token is not correct.");
  return redirect(base, "/", { "set-cookie": sessionCookie(digest, base, 43_200) });
}

async function logout(_request: Request, _deps: AdminDeps, base: string): Promise<Response> {
  return redirect(base, "/login", { "set-cookie": sessionCookie("", base, 0) });
}

async function listPage(request: Request, deps: AdminDeps, base: string): Promise<Response> {
  const error = new URL(request.url).searchParams.get("error");
  const bots = await deps.registry.list(deps.familyId);
  return html(page(base, "Bots", listHtml(base, bots, deps.allowlist, error)));
}

async function newPage(_request: Request, _deps: AdminDeps, base: string): Promise<Response> {
  return html(page(base, "New bot", formHtml(base, null, "")));
}

async function editPage(request: Request, deps: AdminDeps, base: string): Promise<Response> {
  const slug = new URL(request.url).searchParams.get("slug") ?? "";
  const bot = await findBot(deps, slug);
  if (!bot) return textResponse("That bot is not in the registry.", 404);
  return html(page(base, "Edit bot", formHtml(base, bot, "")));
}

async function save(request: Request, deps: AdminDeps, base: string): Promise<Response> {
  const fields = await formFields(request);
  const existing = await findBot(deps, fields.slug ?? "");
  try {
    await saveBotEdit(deps, formToDraft(fields), existing);
  } catch (error) {
    return html(page(base, "Bot", formHtml(base, draftBot(fields), REQUEST_FAILED)));
  }
  return redirect(base, "/", {});
}

async function saveList(request: Request, deps: AdminDeps, base: string): Promise<Response> {
  const fields = await formFields(request);
  try {
    await deps.saveAllowlist(fields.allowlist ?? "");
  } catch (error) {
    const bots = await deps.registry.list(deps.familyId);
    return html(page(base, "Bots", listHtml(base, bots, deps.allowlist, REQUEST_FAILED)));
  }
  return redirect(base, "/", {});
}

async function loginPage(request: Request, _deps: AdminDeps, base: string, failure = ""): Promise<Response> {
  const note = failure || new URL(request.url).searchParams.get("error") || "";
  return html(page(base, "Sign in", loginHtml(base, note)));
}

async function findBot(deps: AdminDeps, slug: string): Promise<BotRecord | null> {
  const bots = await deps.registry.list(deps.familyId);
  return bots.find((bot) => bot.slug === slug) ?? null;
}

function fieldOr(fields: Record<string, string>, key: string, fallback: string): string {
  return fields[key] ?? fallback;
}

function formToDraft(fields: Record<string, string>): Record<string, unknown> {
  return {
    slug: fieldOr(fields, "slug", ""),
    name: fieldOr(fields, "name", ""),
    description: fieldOr(fields, "description", ""),
    activeHours: fieldOr(fields, "activeHours", "always"),
    webhookUrl: fieldOr(fields, "webhookUrl", ""),
    webhookKey: fieldOr(fields, "webhookKey", ""),
    active: fields.active === "true",
  };
}

function draftBot(fields: Record<string, string>): BotRecord {
  const draft = formToDraft(fields);
  return {
    slug: String(draft.slug),
    name: String(draft.name),
    description: String(draft.description),
    activeHours: String(draft.activeHours),
    webhookUrl: String(draft.webhookUrl),
    webhookKeyCiphertext: "",
    active: draft.active === true,
  };
}

export const REQUEST_FAILED = "The request failed. Check the input and try again. Error code: request_failed.";
export const APP_FAILED = "The app failed. Error code: app_failed.";

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function listHtml(base: string, bots: readonly BotRecord[], allowlist: readonly string[], error: string | null): string {
  const rows = bots.map((bot) => rowHtml(base, bot)).join("");
  return `${hubWarning(bots)}${errorHtml(error)}
    <table>
      <thead><tr><th>Slug</th><th>Name</th><th>Hours</th><th>Active</th><th>Key</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p><a href="${escapeHtml(base)}/new">Add a bot</a></p>
    <form method="post" action="${escapeHtml(base)}/allowlist">
      <label>Allowlist <input name="allowlist" value="${escapeHtml(allowlist.join(", "))}"></label>
      <button type="submit">Save allowlist</button>
    </form>
    <form method="post" action="${escapeHtml(base)}/logout"><button type="submit">Sign out</button></form>`;
}

function hubWarning(bots: readonly BotRecord[]): string {
  if (bots.some((bot) => bot.slug === "hub")) return "";
  return "<p>Add a hub entry. Unclear messages go to the hub.</p>";
}

function rowHtml(base: string, bot: BotRecord): string {
  const slug = escapeHtml(bot.slug);
  return `<tr><td><a href="${escapeHtml(base)}/edit?slug=${slug}">${slug}</a></td><td>${escapeHtml(bot.name)}</td><td>${escapeHtml(bot.activeHours)}</td><td>${yesNo(bot.active)}</td><td>${keyState(bot.webhookKeyCiphertext)}</td></tr>`;
}

function yesNo(active: boolean): string {
  if (active) return "yes";
  return "no";
}

function keyState(ciphertext: string): string {
  if (ciphertext === "") return "missing";
  return "set";
}

function botField(bot: BotRecord | null, key: "slug" | "name" | "description" | "activeHours" | "webhookUrl", fallback: string): string {
  if (!bot) return fallback;
  return bot[key];
}

function slugLock(bot: BotRecord | null): string {
  return bot ? "readonly" : "";
}

function checked(bot: BotRecord | null): string {
  if (bot?.active === false) return "";
  return "checked";
}

function formHtml(base: string, bot: BotRecord | null, error: string): string {
  return `${errorHtml(error)}
    <form method="post" action="${escapeHtml(base)}/save">
      <label>Slug <input name="slug" value="${escapeHtml(botField(bot, "slug", ""))}" ${slugLock(bot)} required></label>
      <label>Name <input name="name" value="${escapeHtml(botField(bot, "name", ""))}" required></label>
      <label>Description <textarea name="description" required>${escapeHtml(botField(bot, "description", ""))}</textarea></label>
      <label>Active hours <input name="activeHours" value="${escapeHtml(botField(bot, "activeHours", "always"))}" required></label>
      <label>Webhook URL <input name="webhookUrl" value="${escapeHtml(botField(bot, "webhookUrl", ""))}" required></label>
      <label>Webhook key <input name="webhookKey" type="password" autocomplete="off"></label>
      <label><input name="active" type="checkbox" value="true" ${checked(bot)}> Active</label>
      <button type="submit">Save</button>
    </form>
    <p>Leave the key empty to keep the stored key. The page does not show the key.</p>
    <p><a href="${escapeHtml(base)}/">Back</a></p>`;
}

function loginHtml(base: string, error: string): string {
  return `${errorHtml(error)}
    <form method="post" action="${escapeHtml(base)}/login">
      <label>Admin token <input name="token" type="password" autocomplete="current-password" required></label>
      <button type="submit">Sign in</button>
    </form>`;
}

function errorHtml(error: string | null): string {
  if (!error) return "";
  return `<p>${escapeHtml(error)}</p>`;
}

function page(base: string, title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>
    <style>body{font-family:sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem}label{display:block;margin:0.7rem 0}input,textarea{width:100%}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ccc;padding:0.3rem;text-align:left}</style>
    </head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function redirect(base: string, path: string, headers: Record<string, string>): Response {
  return new Response(null, { status: 303, headers: { location: `${base}${path}`, ...headers } });
}

function sessionCookie(digest: string, base: string, maxAge: number): string {
  return `${COOKIE}=${digest}; HttpOnly; Secure; SameSite=Lax; Path=${cookiePath(base)}; Max-Age=${maxAge}`;
}

function cookiePath(base: string): string {
  return base === "" ? "/" : base;
}

async function formFields(request: Request): Promise<Record<string, string>> {
  const params = new URLSearchParams(await request.text());
  const fields: Record<string, string> = {};
  params.forEach((value, key) => {
    fields[key] = value;
  });
  return fields;
}
