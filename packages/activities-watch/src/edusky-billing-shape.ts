import { authHeaders, CLIENT_SECRET_NAME, login, type Login } from "./edusky-source.ts";
import { isBlockError, errorStatus, withFetches, type FetchDeps } from "./billing-probe-common.ts";
import { jsonShape } from "./billing-redact-json.ts";
import { checkKeys, inputObject } from "./exports.ts";
import { createHttp, type Http } from "./http.ts";
import { activityTargets, type ActivityTarget } from "./targets.ts";
import type { FetchCount } from "@automations/shared";
import type { StorageAdapter } from "@automations/librus-data";

export interface EduskyBillingDeps extends FetchDeps {
  storage: StorageAdapter;
  familyId: string;
}

/** What one Edusky login shows. It has statuses, shapes and one count. It never has a value of the family. */
export interface EduskyBillingRow {
  authStatus?: number;
  authShape?: string;
  listSource?: "auth" | "list";
  listStatus?: number;
  listShape?: string;
  agreementCount?: number;
  agreementStatus?: number;
  agreementShape?: string;
  balanceStatus?: number;
  balanceShape?: string;
}

export interface EduskyBillingAccount extends EduskyBillingRow {
  account: string;
  /** The label of the Account that ran the same probe (same origin and login). */
  sameAs?: string;
  status?: string;
}

export interface EduskyBillingExport {
  accounts: EduskyBillingAccount[];
  fetches?: FetchCount;
}

interface Answer {
  status: number;
  text: string;
}

type ObjectValue = Record<string, unknown>;

const LIST_KEYS = ["data", "items", "rows"];

const isObject = (value: unknown): value is ObjectValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The numeric `id` of every object in an array. */
function idsOf(rows: unknown): number[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => (isObject(row) && typeof row.id === "number" ? [row.id] : []));
}

/** The agreements in the answer of `common/users/auth`: an array under a key with `agreement` in its name. */
function authIds(auth: unknown): number[] {
  if (!isObject(auth)) return [];
  const key = Object.keys(auth).find((name) => /agreement/i.test(name) && idsOf(auth[name]).length > 0);
  return key ? idsOf(auth[key]) : [];
}

/** The agreements in the answer of the list endpoint: a top-level array, or under `data`, `items` or `rows`. */
function listIds(list: unknown): number[] {
  if (Array.isArray(list)) return idsOf(list);
  if (!isObject(list)) return [];
  const key = LIST_KEYS.find((name) => idsOf(list[name]).length > 0);
  return key ? idsOf(list[key]) : [];
}

async function get(http: Http, url: string, accessToken: string): Promise<Answer> {
  const response = await http.request(url, { headers: authHeaders(accessToken) });
  if (response.status === 403 && response.text.includes("Just a moment")) {
    throw new Error("Edusky: blocked by the Cloudflare challenge (HTTP 403)");
  }
  return response;
}

async function readAgreementIds(http: Http, api: string, token: string, auth: unknown, row: EduskyBillingRow): Promise<number[]> {
  const fromAuth = authIds(auth);
  if (fromAuth.length > 0) {
    row.listSource = "auth";
    return fromAuth;
  }
  const list = await get(http, `${api}agreements?page=1&perPage=20`, token);
  row.listSource = "list";
  row.listStatus = list.status;
  row.listShape = jsonShape(list.text) ?? undefined;
  return list.status === 200 ? listIds(parseJson(list.text)) : [];
}

async function readAgreement(http: Http, api: string, token: string, id: number, row: EduskyBillingRow): Promise<void> {
  const agreement = await get(http, `${api}ext/agreements/${id}`, token);
  row.agreementStatus = agreement.status;
  row.agreementShape = jsonShape(agreement.text) ?? undefined;
  const balance = await get(http, `${api}ext/agreementinvoicesbalance?idAgreement=${id}`, token);
  row.balanceStatus = balance.status;
  row.balanceShape = jsonShape(balance.text) ?? undefined;
}

async function secretsOf(deps: FetchDeps, target: ActivityTarget): Promise<Login> {
  const { login_secret, password_secret } = target.account;
  return {
    login: await deps.runtime.secret(login_secret),
    password: await deps.runtime.secret(password_secret),
    clientSecret: await deps.runtime.secret(CLIENT_SECRET_NAME),
  };
}

/** At most 6 requests: base config, token, users/auth, the list, the agreement and its balance. */
async function probeLogin(deps: FetchDeps, target: ActivityTarget): Promise<EduskyBillingRow> {
  const http = createHttp(deps.runtime);
  const { origin } = target.account;
  const token = await login(http, origin, await secretsOf(deps, target));
  const api = `${origin}/core/web/api/`;
  const auth = await get(http, `${api}common/users/auth`, token);
  const row: EduskyBillingRow = { authStatus: auth.status, authShape: jsonShape(auth.text) ?? undefined };
  const ids = await readAgreementIds(http, api, token, parseJson(auth.text), row);
  row.agreementCount = ids.length;
  if (ids[0] !== undefined) await readAgreement(http, api, token, ids[0], row);
  return row;
}

interface Outcome {
  account: EduskyBillingAccount;
  blocked: boolean;
}

async function probeLabelled(deps: FetchDeps, target: ActivityTarget, label: string): Promise<Outcome> {
  try {
    return { account: { account: label, ...(await probeLogin(deps, target)) }, blocked: false };
  } catch (error) {
    const hidden = [new URL(target.account.origin).host, target.account.origin];
    return { account: { account: label, status: errorStatus(error, hidden) }, blocked: isBlockError(error) };
  }
}

/** Read-only probe of the Edusky billing data shape. It takes no input. */
export async function eduskyBillingShapeExport(deps: EduskyBillingDeps, input: unknown = {}): Promise<EduskyBillingExport> {
  checkKeys(inputObject(input), []);
  const config = await deps.storage.loadConfig(deps.familyId);
  const targets = activityTargets(config).targets.filter((target) => target.account.service === "edusky");
  const done = new Map<string, string>();
  const accounts: EduskyBillingAccount[] = [];
  for (const [index, target] of targets.entries()) {
    const label = `account ${index + 1}`;
    const key = `${target.account.origin}\n${target.account.login_secret}`;
    const same = done.get(key);
    if (same) {
      accounts.push({ account: label, sameAs: same });
      continue;
    }
    done.set(key, label);
    const outcome = await probeLabelled(deps, target, label);
    accounts.push(outcome.account);
    if (outcome.blocked) break;
  }
  return withFetches(deps, { accounts });
}
