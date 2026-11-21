import * as cheerio from "cheerio";
import type { FetchCount } from "@automations/shared";
import type { StorageAdapter } from "@automations/librus-data";
import { LABEL_ALLOWLIST, bodySkeleton, redactUrl } from "./activenow-billing-redact.ts";
import { errorStatus, isBlockError, trackLastUrl, withFetches, type FetchDeps } from "./billing-probe-common.ts";
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

export interface CandidateRead {
  path: string;
  status: number;
  finalPath: string;
  contentType: string;
  skeleton: string;
}

export interface MondoBillingAccount {
  account: string;
  status?: string;
  nav?: NavEntry[];
  candidates?: CandidateRead[];
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
const BILLING =
  /payment|platn|płatn|rozlicz|settle|należn|nalezn|faktur|invoice|saldo|balance|financ|finans|wplat|wpłat|billing|oplat|opłat|umow|agreement/i;
/** A page that changes the session is not a billing page, even when its name matches. */
const NOT_A_PAGE = /logout|wyloguj|set-student|\/login/i;
const MAX_CANDIDATES = 3;
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

function isCandidate(entry: RawEntry): boolean {
  const matches = BILLING.test(entry.path) || BILLING.test(entry.label ?? "");
  return matches && !NOT_A_PAGE.test(entry.path);
}

/** Up to 3 entries with a billing word in the masked path or in the label, one for each path. */
export function billingCandidates(entries: RawEntry[]): RawEntry[] {
  const paths = new Set<string>();
  const found: RawEntry[] = [];
  for (const entry of entries) {
    if (!isCandidate(entry) || paths.has(entry.path)) continue;
    paths.add(entry.path);
    found.push(entry);
  }
  return found.slice(0, MAX_CANDIDATES);
}

function navigationSkeleton(html: string): string {
  const $ = cheerio.load(html);
  const areas = $(NAV_AREA).filter((_, node) => $(node).parents(NAV_AREA).length === 0);
  if (areas.length === 0) return bodySkeleton(html);
  return bodySkeleton(areas.toArray().map((node) => $.html(node)).join(""));
}

/** One logged-in panel: the session, its origin, the child hash to mask and the last fetched address. */
interface Panel {
  http: Http;
  origin: string;
  hash: Hashes;
  lastUrl: () => string;
}

/** Masks the child hash in a skeleton: a hash without a digit is not masked by the skeleton. */
const hideHash = (text: string, hashes: Hashes): string => replaceHashes(text, hashes, "<id>");

async function readCandidate(panel: Panel, entry: RawEntry): Promise<CandidateRead> {
  const headers = entry.raw.includes("xhr") ? { "x-requested-with": "XMLHttpRequest" } : undefined;
  const page = await panel.http.request(`${panel.origin}${entry.raw}`, { headers });
  return {
    path: entry.path,
    status: page.status,
    finalPath: maskPath(panel.lastUrl(), panel.hash),
    contentType: page.contentType ?? "",
    skeleton: hideHash(answerSkeleton(page.text), panel.hash),
  };
}

/** Reads the candidates in order. A 403 stops the reads. */
async function readCandidates(panel: Panel, entries: RawEntry[]): Promise<CandidateRead[]> {
  const reads: CandidateRead[] = [];
  for (const entry of billingCandidates(entries)) {
    const read = await readCandidate(panel, entry);
    reads.push(read);
    if (read.status === 403) break;
  }
  return reads;
}

async function selectChild(http: Http, origin: string, child: { hash: string; selected: boolean }): Promise<void> {
  if (child.selected) return;
  const response = await http.request(`${origin}/auth/set-student/${child.hash}`);
  if (response.status === 403) throw new Error("Mondo: HTTP 403 from the child selection");
}

/** At most 5 requests: the login, the child selection and 3 billing candidates. */
async function probeLogin(deps: FetchDeps, target: ActivityTarget): Promise<Omit<MondoBillingAccount, "account">> {
  const tracked = trackLastUrl(deps.runtime);
  const http = createHttp(tracked.runtime);
  const { origin, group, login_secret, password_secret } = target.account;
  const secrets = { login: await deps.runtime.secret(login_secret), password: await deps.runtime.secret(password_secret) };
  const html = await loginPage(http, origin, secrets);
  const child = childOf(html, group ?? target.child.name);
  await selectChild(http, origin, child);
  const hashes = childHashes(html, child.hash);
  const entries = navEntries(html, origin, hashes);
  const candidates = await readCandidates({ http, origin, hash: hashes, lastUrl: tracked.lastUrl }, entries);
  const nav = entries.map(({ path, label }) => ({ path, label }));
  return { nav, candidates, skeleton: hideHash(navigationSkeleton(html), hashes) };
}

interface Outcome {
  account: MondoBillingAccount;
  blocked: boolean;
}

async function probeLabelled(deps: FetchDeps, target: ActivityTarget, label: string): Promise<Outcome> {
  try {
    const row = await probeLogin(deps, target);
    return { account: { account: label, ...row }, blocked: row.candidates?.some((read) => read.status === 403) ?? false };
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
