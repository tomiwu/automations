import { authHeaders, CLIENT_SECRET_NAME, login, type Login } from "./edusky-source.ts";
import { isBlockError, errorStatus, withFetches, type FetchDeps } from "./billing-probe-common.ts";
import { isObject, jsonShape } from "./billing-redact-json.ts";
import { checkKeys, inputObject } from "./exports.ts";
import { createHttp, type Http } from "./http.ts";
import { activityTargets, type ActivityTarget } from "./targets.ts";
import type { FetchCount } from "@automations/shared";
import type { StorageAdapter } from "@automations/librus-data";

export interface EduskyBillingDeps extends FetchDeps {
  storage: StorageAdapter;
  familyId: string;
}

/** What one Edusky login shows. It has statuses, shapes, three flags and the roles. It never has a value of the family. */
export interface EduskyBillingRow {
  authStatus?: number;
  authShape?: string;
  flags?: FinanceFlags;
  roles?: string[];
}

/** `0` or `1` for a boolean-like value, `null` for a missing key, `"<other>"` for anything else. */
export type FlagValue = 0 | 1 | null | "<other>";

export interface FinanceFlags {
  financeDisable: FlagValue;
  blockSettlementView: FlagValue;
  blockSettlementInfo: FlagValue;
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

const FLAG_NAMES = ["financeDisable", "blockSettlementView", "blockSettlementInfo"] as const;
const ROLE = /^ROLE_[A-Z_]{1,40}$/;

const shapeOf = (answer: Answer): string | undefined => jsonShape(answer.text) ?? undefined;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const FLAG_OFF = new Set<unknown>([0, "0", false]);
const FLAG_ON = new Set<unknown>([1, "1", true]);

export function flagValue(value: unknown): FlagValue {
  if (value === undefined) return null;
  if (FLAG_OFF.has(value)) return 0;
  return FLAG_ON.has(value) ? 1 : "<other>";
}

/** The three finance flags of the answer of `common/users/auth`. */
export function financeFlags(auth: unknown): FinanceFlags {
  const source = isObject(auth) ? auth : {};
  const [financeDisable, blockSettlementView, blockSettlementInfo] = FLAG_NAMES.map((name) => flagValue(source[name]));
  return { financeDisable, blockSettlementView, blockSettlementInfo } as FinanceFlags;
}

/** The values of `roles` that look like a role name. Other values become `<text>`. */
export function rolesOf(auth: unknown): string[] {
  const roles = isObject(auth) ? auth.roles : undefined;
  if (!Array.isArray(roles)) return [];
  return roles.map((role) => (typeof role === "string" && ROLE.test(role) ? role : "<text>"));
}

async function get(http: Http, url: string, accessToken: string): Promise<Answer> {
  const response = await http.request(url, { headers: authHeaders(accessToken) });
  if (response.status === 403 && response.text.includes("Just a moment")) {
    throw new Error("Edusky: blocked by the Cloudflare challenge (HTTP 403)");
  }
  return response;
}

async function secretsOf(deps: FetchDeps, target: ActivityTarget): Promise<Login> {
  const { login_secret, password_secret } = target.account;
  return {
    login: await deps.runtime.secret(login_secret),
    password: await deps.runtime.secret(password_secret),
    clientSecret: await deps.runtime.secret(CLIENT_SECRET_NAME),
  };
}

/** At most 3 requests: base config, token and users/auth. A parent has no agreement list. */
async function probeLogin(deps: FetchDeps, target: ActivityTarget): Promise<EduskyBillingRow> {
  const http = createHttp(deps.runtime);
  const { origin } = target.account;
  const token = await login(http, origin, await secretsOf(deps, target));
  const auth = await get(http, `${origin}/core/web/api/common/users/auth`, token);
  const body = parseJson(auth.text);
  return { authStatus: auth.status, authShape: shapeOf(auth), flags: financeFlags(body), roles: rolesOf(body) };
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
