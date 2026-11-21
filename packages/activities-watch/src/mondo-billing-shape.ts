import * as cheerio from "cheerio";
import type { FetchCount } from "@automations/shared";
import type { StorageAdapter } from "@automations/librus-data";
import { LABEL_ALLOWLIST, bodySkeleton, maskEmails, redactUrl } from "./activenow-billing-redact.ts";
import { errorStatus, isBlockError, withFetches, type FetchDeps } from "./billing-probe-common.ts";
import { answerSkeleton } from "./billing-redact-json.ts";
import { checkKeys, inputObject } from "./exports.ts";
import { createHttp, type Http } from "./http.ts";
import { childOf, loginPage } from "./mondo-source.ts";
import { activityTargets, type ActivityTarget } from "./targets.ts";

export interface MondoBillingDeps extends FetchDeps {
  storage: StorageAdapter;
  familyId: string;
}

export interface NavEntry {
  path: string;
  /** Only for a link (`a[href]`): the text when it is on the allowlist, else `<text>`. */
  label?: string;
}

/** One XHR answer: the masked path, the status, the content type and the redacted skeleton. */
export interface XhrRead {
  path: string;
  status: number;
  contentType: string;
  skeleton: string;
}

/** A path from a script that the probe did not fetch, and why. */
export interface SkippedPath {
  path: string;
  reason: string;
}

export interface MondoBillingAccount {
  account: string;
  status?: string;
  nav?: NavEntry[];
  /** `xhr-account` and `xhr-activity/<selected child hash>`. */
  xhr?: XhrRead[];
  /** Up to 12 redacted script snippets around `xhr-` or `saldo`. */
  snippets?: string[];
  /** Up to 2 followed paths, and the paths that were skipped with a reason. */
  followed?: (XhrRead | SkippedPath)[];
  /** The skeleton of the navigation area of the panel page, or of the whole body without one. */
  skeleton?: string;
}

export interface MondoBillingExport {
  accounts: MondoBillingAccount[];
  fetches?: FetchCount;
}

interface RawNode {
  tag: string;
  attribs: Record<string, string>;
  text: string;
}

interface RawEntry {
  /** The path with the query, as the page has it. It is used for a request and never returned. */
  raw: string;
  path: string;
  label?: string;
}

const NODE_SELECTOR = "a[href], [data-url], [data-href], [data-action-url], form[action], [onclick]";
const DATA_ATTRS = ["data-url", "data-href", "data-action-url"];
const ONCLICK_PATH = /["'](\/[^"']*)["']/g;
const NAV_AREA = "nav, aside, header, [role=navigation]";
/** A path with one of these words may have billing data. */
const FOLLOW_WORD = /saldo|payment|platn|płatn|oplat|opłat|transak|xhr-/i;
/** A page that changes the session or the language is never fetched, even when its name matches. */
const NOT_A_PAGE = /logout|wyloguj|login|set-student|change-lang/i;
const MAX_FOLLOWED = 2;
const MAX_SKIPPED = 5;
const MAX_SNIPPETS = 12;
const SNIPPET_MARGIN = 150;
const SNIPPET_LIMIT = 400;
const SNIPPET_MATCH = /xhr-|saldo/gi;
const KEPT_LITERAL = /^[a-z0-9_.:-]{1,40}$/;
const XHR_ACCOUNT = "/parent/xhr-account";
const ID_SENTINEL = "ZZIDZZ";

type Hashes = string | readonly string[];

const hashList = (hashes: Hashes): string[] =>
  (typeof hashes === "string" ? [hashes] : [...hashes]).filter(Boolean).sort((a, b) => b.length - a.length);

const replaceHashes = (text: string, hashes: Hashes, mark: string): string =>
  hashList(hashes).reduce((acc, hash) => acc.split(hash).join(mark), text);

/** Every child hash of the child picker (`/parent/photo-children/<hash>`), not only the selected one. */
export function childHashes(html: string, selected: string): string[] {
  const found = [...html.matchAll(/photo-children\/([\w-]+)/g)].map((match) => match[1] ?? "");
  return [...new Set([selected, ...found])].filter(Boolean);
}

/** The redacted path: each child hash becomes `<id>`, every digit run `<n>`, query values are dropped. */
export function maskPath(raw: string, hashes: Hashes): string {
  return replaceHashes(redactUrl(replaceHashes(raw, hashes, ID_SENTINEL)), ID_SENTINEL, "<id>");
}

function labelOf(text: string): string {
  const label = text.replace(/\s+/g, " ").trim();
  return LABEL_ALLOWLIST.has(label) ? label : "<text>";
}

/** The path with the query when the value points to the same origin, else null. */
function samePath(value: string, origin: string): string | null {
  if (value.trim().startsWith("#")) return null;
  try {
    const base = new URL(origin).origin;
    const url = new URL(value.trim(), `${base}/`);
    return url.origin === base ? `${url.pathname}${url.search}` : null;
  } catch {
    return null;
  }
}

interface FoundValue {
  value: string;
  label?: string;
}

function linkValues(node: RawNode): FoundValue[] {
  const href = node.attribs.href;
  return node.tag === "a" && href ? [{ value: href, label: labelOf(node.text) }] : [];
}

function formValues(node: RawNode): FoundValue[] {
  const action = node.attribs.action;
  return node.tag === "form" && action ? [{ value: action }] : [];
}

function dataValues(attribs: Record<string, string>): FoundValue[] {
  return DATA_ATTRS.flatMap((name) => (attribs[name] ? [{ value: attribs[name] }] : []));
}

function onclickValues(attribs: Record<string, string>): FoundValue[] {
  return [...(attribs.onclick ?? "").matchAll(ONCLICK_PATH)].map((match) => ({ value: match[1] ?? "" }));
}

function nodeValues(node: RawNode): FoundValue[] {
  return [...linkValues(node), ...formValues(node), ...dataValues(node.attribs), ...onclickValues(node.attribs)];
}

function rawNodes(html: string): RawNode[] {
  const $ = cheerio.load(html);
  return $(NODE_SELECTOR)
    .toArray()
    .map((node) => ({
      tag: String($(node).prop("tagName") ?? "").toLowerCase(),
      attribs: $(node).attr() ?? {},
      text: $(node).text(),
    }));
}

/** Every same-origin path of the navigation, in page order, without duplicates (by masked path and label). */
export function navEntries(html: string, origin: string, hash: Hashes): RawEntry[] {
  const seen = new Set<string>();
  const entries: RawEntry[] = [];
  for (const { value, label } of rawNodes(html).flatMap(nodeValues)) {
    const raw = samePath(value, origin);
    if (raw === null) continue;
    const path = maskPath(raw, hash);
    const key = `${path}\n${label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ raw, path, label });
  }
  return entries;
}

function navigationSkeleton(html: string): string {
  const $ = cheerio.load(html);
  const areas = $(NAV_AREA).filter((_, node) => $(node).parents(NAV_AREA).length === 0);
  if (areas.length === 0) return bodySkeleton(html);
  return bodySkeleton(areas.toArray().map((node) => $.html(node)).join(""));
}

/** Texts that never show in a result: the child hashes and the hidden words (group, Child name, origin host). */
interface Mask {
  hashes: readonly string[];
  hidden: readonly string[];
}

/** One logged-in panel: the session, its origin, the selected child hash and the texts to mask. */
interface Panel {
  http: Http;
  origin: string;
  selected: string;
  mask: Mask;
}

/** An answer with its text. The text is used for the script scan and never returned. */
interface Fetched {
  read: XhrRead;
  text: string;
}

/** Masks the child hash in a skeleton: a hash without a digit is not masked by the skeleton. */
const hideHash = (text: string, hashes: Hashes): string => replaceHashes(text, hashes, "<id>");

async function readXhr(panel: Panel, raw: string): Promise<Fetched> {
  const headers = raw.includes("xhr") ? { "x-requested-with": "XMLHttpRequest" } : undefined;
  const page = await panel.http.request(`${panel.origin}${raw}`, { headers });
  const read = {
    path: maskPath(raw, panel.mask.hashes),
    status: page.status,
    contentType: page.contentType ?? "",
    skeleton: hideHash(answerSkeleton(page.text), panel.mask.hashes),
  };
  return { read, text: page.text };
}

/** Reads the paths in order. A 403 stops the reads. */
async function readAll(panel: Panel, paths: string[]): Promise<Fetched[]> {
  const reads: Fetched[] = [];
  for (const raw of paths) {
    const fetched = await readXhr(panel, raw);
    reads.push(fetched);
    if (fetched.read.status === 403) break;
  }
  return reads;
}

const isBlocked = (reads: Fetched[]): boolean => reads.some((fetched) => fetched.read.status === 403);

/** The text of every inline `<script>` of a page. */
export function inlineScripts(html: string): string[] {
  const $ = cheerio.load(html);
  return $("script")
    .toArray()
    .map((node) => $(node).text())
    .filter((text) => text.trim() !== "");
}

/** A part of a script: a quoted string literal (`quote` is set, `text` is its body), or code (a comment is code). */
interface Piece {
  start: number;
  end: number;
  text: string;
  quote?: string;
}

const PIECE =
  /(?<comment>\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|(?<quote>["'`])(?<body>(?:\\.|(?!\k<quote>)[^\\\n])*)\k<quote>?/g;

function pieceOf(match: RegExpMatchArray): Piece {
  const start = match.index ?? 0;
  const end = start + match[0].length;
  if (match.groups?.comment !== undefined) return { start, end, text: match[0] };
  return { start, end, text: match.groups?.body ?? "", quote: match.groups?.quote };
}

/** Splits a script into literals and code. A literal that has no end runs to the end of the line. */
export function scriptPieces(script: string): Piece[] {
  const pieces: Piece[] = [];
  let at = 0;
  for (const match of script.matchAll(PIECE)) {
    const piece = pieceOf(match);
    if (piece.start > at) pieces.push({ start: at, end: piece.start, text: script.slice(at, piece.start) });
    pieces.push(piece);
    at = piece.end;
  }
  if (at < script.length) pieces.push({ start: at, end: script.length, text: script.slice(at) });
  return pieces;
}

const EMAIL_TOKEN = "ZZEMAILZZ";
const HIDDEN_TOKEN = "ZZHIDDENZZ";

/** The code text of a snippet: e-mails, child hashes, hidden words and digit runs are masked. */
function redactCode(text: string, mask: Mask): string {
  const hidden = replaceHashes(replaceHashes(maskEmails(text), mask.hashes, "<id>"), mask.hidden, "<hidden>");
  return hidden.replace(/\d+/g, "<n>");
}

/** A literal that starts with `/` is a path. Words that must not show are swapped for URL-safe tokens first. */
function redactPathLiteral(body: string, mask: Mask): string {
  const safe = replaceHashes(replaceHashes(maskEmails(body), mask.hidden, HIDDEN_TOKEN), mask.hashes, ID_SENTINEL);
  const path = redactUrl(safe.split("<email>").join(EMAIL_TOKEN));
  return path.split(ID_SENTINEL).join("<id>").split(HIDDEN_TOKEN).join("<hidden>").split(EMAIL_TOKEN).join("<email>");
}

/** A literal is kept when it is a path (redacted) or a short code word. Else it becomes `"<text>"`. */
export function redactLiteral(body: string, mask: Mask): string {
  if (body.startsWith("/")) return `"${redactPathLiteral(body, mask)}"`;
  const clean = redactCode(body, mask);
  const plain = clean === body.replace(/\d+/g, "<n>") && KEPT_LITERAL.test(body);
  return plain ? `"${clean}"` : '"<text>"';
}

function redactPiece(piece: Piece, from: number, to: number, mask: Mask): string {
  if (piece.quote !== undefined) return redactLiteral(piece.text, mask);
  return redactCode(piece.text.slice(Math.max(from - piece.start, 0), to - piece.start), mask);
}

/** The redacted text of a script between two offsets. A literal that touches the window is redacted whole. */
function redactWindow(pieces: Piece[], window: Window, mask: Mask): string {
  const inside = pieces.filter((piece) => piece.end > window.from && piece.start < window.to);
  return inside
    .map((piece) => redactPiece(piece, window.from, window.to, mask))
    .join("")
    .slice(0, SNIPPET_LIMIT);
}

interface Window {
  from: number;
  to: number;
}

/** The windows around each match of `xhr-` or `saldo`. A match inside the last window gives no new window. */
function matchWindows(script: string): Window[] {
  const windows: Window[] = [];
  for (const match of script.matchAll(SNIPPET_MATCH)) {
    const at = match.index ?? 0;
    if (at < (windows.at(-1)?.to ?? 0)) continue;
    windows.push({ from: Math.max(at - SNIPPET_MARGIN, 0), to: at + match[0].length + SNIPPET_MARGIN });
  }
  return windows;
}

/** Up to 12 redacted snippets from the scripts, without duplicates. */
export function scriptSnippets(scripts: string[], mask: Mask): string[] {
  const found = new Set<string>();
  for (const script of scripts) {
    const pieces = scriptPieces(script);
    for (const window of matchWindows(script)) found.add(redactWindow(pieces, window, mask));
  }
  return [...found].slice(0, MAX_SNIPPETS);
}

/** A path as a script has it: with a flag for the child hash placeholder (`'/parent/x/' + hash`). */
interface ScriptPath {
  raw: string;
  /** `variable`: a variable follows the literal. `bare`: the literal ends with `/` and no variable follows. */
  placeholder?: "variable" | "bare";
}

const PATH_LITERAL = /(["'`])(\/(?:(?!\1)[^\\\n])*)\1(\s*\+\s*[A-Za-z_$])?/g;

function scriptPath(body: string, plus: string | undefined): ScriptPath {
  const cut = body.indexOf("${");
  if (cut >= 0) return { raw: body.slice(0, cut), placeholder: "variable" };
  if (!body.endsWith("/")) return { raw: body };
  return { raw: body, placeholder: plus ? "variable" : "bare" };
}

/** Every string literal of a script text that starts with `/`. */
export function scriptPaths(text: string): ScriptPath[] {
  return [...text.matchAll(PATH_LITERAL)].map((match) => scriptPath(match[2] ?? "", match[3]));
}

type Fetchable = { raw: string; path: string };
type Resolved = Fetchable | SkippedPath;

/** The same-origin path of a billing path, or null for another path or a path that is never fetched. */
function billingPath(found: ScriptPath, origin: string): string | null {
  const raw = samePath(found.raw, origin);
  return raw !== null && FOLLOW_WORD.test(raw) && !NOT_A_PAGE.test(raw) ? raw : null;
}

/** The path to fetch, or the reason to skip it. A path that is not a billing path gives null. */
function resolvePath(found: ScriptPath, panel: Panel): Resolved | null {
  const raw = billingPath(found, panel.origin);
  if (raw === null) return null;
  const { hashes } = panel.mask;
  if (found.placeholder === "bare") return { path: maskPath(raw, hashes), reason: "path ends with / and no variable follows" };
  const full = found.placeholder === "variable" ? `${raw}${panel.selected}` : raw;
  return { raw: full, path: maskPath(full, hashes) };
}

const isFetchable = (resolved: Resolved): resolved is Fetchable => "raw" in resolved;

/** Paths of the attributes of an answer. */
const attributePaths = (html: string, origin: string): ScriptPath[] =>
  navEntries(html, origin, []).map((entry) => ({ raw: entry.raw }));

interface Plan {
  fetch: string[];
  skipped: SkippedPath[];
}

function addToPlan(plan: Plan, resolved: Resolved): void {
  if (!isFetchable(resolved)) {
    if (plan.skipped.length < MAX_SKIPPED) plan.skipped.push(resolved);
  } else if (plan.fetch.length < MAX_FOLLOWED) {
    plan.fetch.push(resolved.raw);
  }
}

/** Picks up to 2 paths to fetch and the skipped paths. A path fetched before, or seen before, is dropped. */
export function followPlan(found: ScriptPath[], panel: Panel, fetched: string[]): Plan {
  const seen = new Set(fetched);
  const plan: Plan = { fetch: [], skipped: [] };
  for (const item of found) {
    const resolved = resolvePath(item, panel);
    if (!resolved || seen.has(resolved.path)) continue;
    seen.add(resolved.path);
    addToPlan(plan, resolved);
  }
  return plan;
}

/** The raw script windows around each match, for the path scan. */
function rawWindows(script: string): string[] {
  return matchWindows(script).map((window) => script.slice(window.from, window.to));
}

/** Every path that may lead to billing data: snippets of the three pages, then the two answers in full. */
function followCandidates(panelHtml: string, answers: Fetched[], origin: string): ScriptPath[] {
  const answerScripts = answers.flatMap((answer) => inlineScripts(answer.text));
  const snippetTexts = [panelHtml, ...answers.map((answer) => answer.text)].flatMap(inlineScripts).flatMap(rawWindows);
  const attributes = answers.flatMap((answer) => attributePaths(answer.text, origin));
  return [...snippetTexts, ...answerScripts].flatMap(scriptPaths).concat(attributes);
}

async function selectChild(http: Http, origin: string, child: { hash: string; selected: boolean }): Promise<void> {
  if (child.selected) return;
  const response = await http.request(`${origin}/auth/set-student/${child.hash}`);
  if (response.status === 403) throw new Error("Mondo: HTTP 403 from the child selection");
}

type Row = Omit<MondoBillingAccount, "account">;
type Followed = (XhrRead | SkippedPath)[];

/** The follow-up: reads up to 2 new paths and lists the skipped ones. */
async function followUp(panel: Panel, html: string, answers: Fetched[]): Promise<{ followed: Followed; blocked: boolean }> {
  const plan = followPlan(followCandidates(html, answers, panel.origin), panel, answers.map((a) => a.read.path));
  const reads = await readAll(panel, plan.fetch);
  return { followed: [...reads.map((fetched) => fetched.read), ...plan.skipped], blocked: isBlocked(reads) };
}

/** At most 6 requests: the login, the child selection, 2 XHR answers and 2 followed paths. */
async function probeLogin(deps: FetchDeps, target: ActivityTarget): Promise<{ row: Row; blocked: boolean }> {
  const http = createHttp(deps.runtime);
  const { origin, group, login_secret, password_secret } = target.account;
  const secrets = { login: await deps.runtime.secret(login_secret), password: await deps.runtime.secret(password_secret) };
  const html = await loginPage(http, origin, secrets);
  const child = childOf(html, group ?? target.child.name);
  await selectChild(http, origin, child);
  const hashes = childHashes(html, child.hash);
  const hidden = [group, target.child.name, new URL(origin).host].filter((text): text is string => Boolean(text));
  const mask = { hashes, hidden };
  const panel = { http, origin, selected: child.hash, mask };
  const answers = await readAll(panel, [XHR_ACCOUNT, `/parent/xhr-activity/${child.hash}`]);
  const snippets = scriptSnippets([html, ...answers.map((a) => a.text)].flatMap(inlineScripts), mask);
  const later = isBlocked(answers) ? { followed: [], blocked: true } : await followUp(panel, html, answers);
  const row = {
    nav: navEntries(html, origin, hashes).map(({ path, label }) => ({ path, label })),
    xhr: answers.map((fetched) => fetched.read),
    snippets,
    followed: later.followed,
    skeleton: hideHash(navigationSkeleton(html), hashes),
  };
  return { row, blocked: later.blocked };
}

interface Outcome {
  account: MondoBillingAccount;
  blocked: boolean;
}

async function probeLabelled(deps: FetchDeps, target: ActivityTarget, label: string): Promise<Outcome> {
  try {
    const { row, blocked } = await probeLogin(deps, target);
    return { account: { account: label, ...row }, blocked };
  } catch (error) {
    const { origin, group } = target.account;
    const hidden = [new URL(origin).host, origin, group, target.child.name];
    return { account: { account: label, status: errorStatus(error, hidden) }, blocked: isBlockError(error) };
  }
}

/** Read-only probe of the Mondo billing page shape. It takes no input. */
export async function mondoBillingShapeExport(deps: MondoBillingDeps, input: unknown = {}): Promise<MondoBillingExport> {
  checkKeys(inputObject(input), []);
  const config = await deps.storage.loadConfig(deps.familyId);
  const targets = activityTargets(config).targets.filter((target) => target.account.service === "mondo");
  const accounts: MondoBillingAccount[] = [];
  for (const [index, target] of targets.entries()) {
    const outcome = await probeLabelled(deps, target, `account ${index + 1}`);
    accounts.push(outcome.account);
    if (outcome.blocked) break;
  }
  return withFetches(deps, { accounts });
}
