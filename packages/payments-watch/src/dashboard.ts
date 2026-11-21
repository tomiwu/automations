import type { StorageAdapter } from "@automations/librus-data";
import { localDate, t, type Language, type MessageKey } from "@automations/shared";
import { decidePayment } from "./decision.ts";
import { formatAmount } from "./engine.ts";
import { buildDashboard, type Dashboard, type DashboardRow, type MarkedBy } from "./dashboard-data.ts";
import type { DashboardUser } from "./dashboard-config.ts";

export interface DashboardDeps {
  storage: StorageAdapter;
  familyId: string;
  allowlist: readonly DashboardUser[];
  now: () => Date;
}

interface Context {
  deps: DashboardDeps;
  base: string;
  language: Language;
}

const COOKIE = "payments_dashboard";
const SESSION_SECONDS = 43_200;

export function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** SHA-256 of a text, in hex. */
export async function tokenDigest(token: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameText(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}

function routePath(url: string, base: string): string {
  const path = new URL(url).pathname.replace(/\/+$/, "");
  const local = base && path.startsWith(base) ? path.slice(base.length) : path;
  return local === "" ? "/" : local;
}

function cookieValue(header: string | null, name: string): string {
  for (const part of (header ?? "").split(";")) {
    const text = part.trim();
    if (text.startsWith(`${name}=`)) return text.slice(name.length + 1);
  }
  return "";
}

async function sessionValue(entry: DashboardUser): Promise<string> {
  return `${entry.user}.${await tokenDigest(entry.tokenDigest)}`;
}

async function sessionUser(request: Request, allowlist: readonly DashboardUser[]): Promise<DashboardUser | null> {
  const cookie = cookieValue(request.headers.get("cookie"), COOKIE);
  for (const entry of allowlist) {
    if (sameText(cookie, await sessionValue(entry))) return entry;
  }
  return null;
}

async function formFields(request: Request): Promise<URLSearchParams> {
  return new URLSearchParams(await request.text());
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function redirect(base: string, path: string, cookie?: string): Response {
  const headers: Record<string, string> = { location: `${base}${path}` };
  if (cookie !== undefined) headers["set-cookie"] = cookie;
  return new Response(null, { status: 303, headers });
}

function cookieHeader(value: string, base: string, maxAge: number): string {
  return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${base === "" ? "/" : base}; Max-Age=${maxAge}`;
}

function page(context: Context, body: string): string {
  const title = escapeHtml(t(context.language, "dashboard.title"));
  return `<!doctype html><html lang="${context.language}"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>${title}</title>
    <style>body{font-family:sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem}label{display:block;margin:0.7rem 0}input{width:100%}table{border-collapse:collapse;width:100%;margin-bottom:1rem}td,th{border:1px solid #ccc;padding:0.3rem;text-align:left}</style>
    </head><body><h1>${title}</h1>${body}</body></html>`;
}

function loginHtml(context: Context, failure: boolean): string {
  const lang = context.language;
  const note = failure ? `<p>${escapeHtml(t(lang, "dashboard.signin_failed"))}</p>` : "";
  return `${note}<form method="post" action="${escapeHtml(context.base)}/login">
      <label>${escapeHtml(t(lang, "dashboard.user"))} <input name="user" autocomplete="username" required></label>
      <label>${escapeHtml(t(lang, "dashboard.token"))} <input name="token" type="password" autocomplete="current-password" required></label>
      <button type="submit">${escapeHtml(t(lang, "dashboard.signin"))}</button>
    </form>`;
}

function cell(value: string): string {
  return `<td>${escapeHtml(value)}</td>`;
}

function headRow(language: Language, keys: readonly MessageKey[]): string {
  return `<tr>${keys.map((key) => `<th>${escapeHtml(t(language, key))}</th>`).join("")}</tr>`;
}

/** Rows are text cells. `extra` is trusted HTML for one more cell at the end of a row. */
function section(language: Language, title: MessageKey, head: readonly MessageKey[], rows: readonly string[][], extra: readonly string[] = []): string {
  const heading = `<h2>${escapeHtml(t(language, title))}</h2>`;
  if (rows.length === 0) return `${heading}<p>${escapeHtml(t(language, "dashboard.none"))}</p>`;
  const body = rows.map((row, index) => `<tr>${row.map(cell).join("")}${extra[index] ?? ""}</tr>`).join("");
  return `${heading}<table><thead>${headRow(language, head)}</thead><tbody>${body}</tbody></table>`;
}

const ROW_HEAD: MessageKey[] = ["dashboard.col.child", "dashboard.col.organizer", "dashboard.col.month", "dashboard.col.due", "dashboard.col.amount"];

const rowCells = (row: DashboardRow): string[] => [row.child, row.organizer, row.month, row.dueDate, formatAmount(row.amount)];

function decisionForm(context: Context, row: DashboardRow, action: "paid" | "skip"): string {
  const url = `${context.base}/payments/${encodeURIComponent(row.paymentId)}/${action}`;
  const label = t(context.language, `payment.button.${action}`);
  return `<form method="post" action="${escapeHtml(url)}"><button type="submit">${escapeHtml(label)}</button></form>`;
}

function actionCell(context: Context, row: DashboardRow): string {
  if (row.status !== "pending") return "<td></td>";
  return `<td>${decisionForm(context, row, "paid")}${decisionForm(context, row, "skip")}</td>`;
}

function refundCell(language: Language, row: DashboardRow): string {
  return `<td>${row.refundCheck ? escapeHtml(t(language, "dashboard.refund_check")) : ""}</td>`;
}

function markedByText(language: Language, markedBy: MarkedBy): string {
  switch (markedBy.kind) {
    case "telegram": return t(language, "dashboard.marked.telegram");
    case "dashboard": return t(language, "dashboard.marked.dashboard", { user: markedBy.user });
    case "organizer": return t(language, "dashboard.marked.organizer", { service: markedBy.service });
    case "unknown": return t(language, "dashboard.marked.unknown");
  }
}

const PAID_HEAD: MessageKey[] = [...ROW_HEAD, "dashboard.col.paid_at", "dashboard.col.marked_by", "dashboard.col.amount_source", "dashboard.col.refund"];

const paidCells = (language: Language, row: DashboardRow): string[] => [
  ...rowCells(row),
  row.decidedAt ?? "",
  markedByText(language, row.markedBy),
  t(language, `dashboard.source.${row.amountSource}`),
];

function viewHtml(context: Context, view: Dashboard): string {
  const lang = context.language;
  return [
    section(lang, "dashboard.unpaid", [...ROW_HEAD, "dashboard.col.actions"], view.unpaid.map(rowCells), view.unpaid.map((row) => actionCell(context, row))),
    section(lang, "dashboard.next_due", ROW_HEAD, view.nextDue.map(rowCells)),
    section(lang, "dashboard.paid", PAID_HEAD, view.paid.map((row) => paidCells(lang, row)), view.paid.map((row) => refundCell(lang, row))),
    section(lang, "dashboard.cancelled", ROW_HEAD, view.cancelled.map(rowCells)),
    section(lang, "dashboard.spend_month", ["dashboard.col.child", "dashboard.col.month", "dashboard.col.amount"],
      view.spendByMonth.map((s) => [s.child, s.month, formatAmount(s.total)])),
    section(lang, "dashboard.spend_year", ["dashboard.col.child", "dashboard.col.school_year", "dashboard.col.amount"],
      view.spendBySchoolYear.map((s) => [s.child, s.schoolYear, formatAmount(s.total)])),
    `<form method="post" action="${escapeHtml(context.base)}/logout"><button type="submit">${escapeHtml(t(lang, "dashboard.signout"))}</button></form>`,
  ].join("");
}

async function overview(context: Context): Promise<Response> {
  const { storage, familyId, now } = context.deps;
  const [config, fees, payments] = await Promise.all([storage.loadConfig(familyId), storage.listFees(familyId), storage.listPayments(familyId)]);
  const today = localDate(now(), config.family.timezone);
  const view = buildDashboard({ children: config.children, fees, payments, today, timezone: config.family.timezone });
  return html(page(context, viewHtml(context, view)));
}

async function login(request: Request, context: Context): Promise<Response> {
  const fields = await formFields(request);
  const digest = await tokenDigest(fields.get("token") ?? "");
  const entry = context.deps.allowlist.find((candidate) => candidate.user === fields.get("user"));
  if (!entry || !sameText(digest, entry.tokenDigest)) return html(page(context, loginHtml(context, true)));
  return redirect(context.base, "/", cookieHeader(await sessionValue(entry), context.base, SESSION_SECONDS));
}

const DECISION_PATH = /^\/payments\/([^/]+)\/(paid|skip)$/;

async function decideKnown(context: Context, paymentId: string, decision: "paid" | "skipped", decidedBy: string): Promise<void> {
  const { storage, familyId, now } = context.deps;
  const payment = (await storage.listPayments(familyId)).find((candidate) => candidate.id === paymentId);
  const fee = payment && (await storage.listFees(familyId)).find((candidate) => candidate.id === payment.feeId);
  if (payment && fee) await decidePayment({ storage, familyId, payment, fee, decision, decidedBy, at: now() });
}

/**
 * Sets the status with the same function as the Telegram callback (`decidePayment`). The first press wins.
 * A repeated press changes nothing. Both end in a redirect to the overview.
 */
async function decide(request: Request, context: Context, route: string): Promise<Response> {
  const user = await sessionUser(request, context.deps.allowlist);
  if (!user) return html(page(context, loginHtml(context, false)));
  const match = DECISION_PATH.exec(route);
  if (!match) return notFound(context);
  const status = match[2] === "paid" ? "paid" : "skipped";
  await decideKnown(context, decodeURIComponent(match[1] ?? ""), status, user.user);
  return redirect(context.base, "/");
}

function notFound(context: Context): Response {
  return html(escapeHtml(t(context.language, "dashboard.not_found")), 404);
}

async function readRoute(request: Request, context: Context, route: string): Promise<Response> {
  if (route === "GET /login" || !(await sessionUser(request, context.deps.allowlist))) return html(page(context, loginHtml(context, false)));
  return overview(context);
}

/**
 * Serves the Dashboard: the read view and the Paid and Skip buttons. Every page except the login needs a session of a user on the allowlist.
 * A request without one gets the login page and no data.
 */
export async function handleDashboard(request: Request, deps: DashboardDeps, base: string): Promise<Response> {
  const config = await deps.storage.loadConfig(deps.familyId);
  const context: Context = { deps, base, language: config.family.default_language };
  const route = `${request.method} ${routePath(request.url, base)}`;
  if (request.method === "POST") return postRoute(request, context, route);
  return route === "GET /" || route === "GET /login" ? readRoute(request, context, route) : notFound(context);
}

async function postRoute(request: Request, context: Context, route: string): Promise<Response> {
  if (route === "POST /login") return login(request, context);
  if (route === "POST /logout") return redirect(context.base, "/login", cookieHeader("", context.base, 0));
  if (route.startsWith("POST /payments/")) return decide(request, context, route.slice("POST ".length));
  return notFound(context);
}
