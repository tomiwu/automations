import * as cheerio from "cheerio";
import type { FetchCount, FetchCounter, Runtime } from "@automations/shared";
import { formatFetchCount } from "@automations/shared";
import { ACTIVE_NOW_BLOCK, blockPage, isActiveNowBlock, openActiveNowPanel } from "./activenow-source.ts";
import { bodySkeleton, redactUrl } from "./activenow-billing-redact.ts";
import { checkKeys, inputObject } from "./exports.ts";
import { createHttp, type Http, type HttpResult } from "./http.ts";
import { activityTargets, type ActivityTarget } from "./targets.ts";
import type { StorageAdapter } from "@automations/librus-data";

export interface BillingShapeDeps {
  runtime: Runtime;
  storage: StorageAdapter;
  familyId: string;
  counter?: FetchCounter;
}

export interface BillingShapeAccount {
  account: string;
  status?: string;
  billingLink: string | null;
  billingPath?: string;
  billingStatus?: number;
  skeleton: string;
}

export interface BillingShapeExport {
  accounts: BillingShapeAccount[];
  fetches?: FetchCount;
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

async function readBilling(http: Http, url: string): Promise<HttpResult> {
  return http.request(url);
}

async function probeAccount(http: Http, target: ActivityTarget, runtime: Runtime): Promise<BillingShapeAccount> {
  const { origin, group, login_secret, password_secret } = target.account;
  const secrets = { login: await runtime.secret(login_secret), password: await runtime.secret(password_secret) };
  const panel = await openActiveNowPanel(http, origin, secrets, group);
  const billing = billingHref(panel, origin);
  if (billing === null) {
    return { account: "", billingLink: null, skeleton: bodySkeleton(panel) };
  }
  const page = await readBilling(http, billing);
  if (page.status === 403 && blockPage(page.text)) throw new Error(ACTIVE_NOW_BLOCK);
  return {
    account: "",
    billingLink: redactUrl(billing),
    billingPath: redactUrl(billing),
    billingStatus: page.status,
    skeleton: bodySkeleton(page.text),
  };
}

function withFetches(deps: BillingShapeDeps, result: BillingShapeExport): BillingShapeExport {
  if (!deps.counter) return result;
  const fetches = deps.counter.count();
  deps.runtime.log("info", formatFetchCount(fetches));
  return { ...result, fetches };
}

/** Read-only probe of the ActiveNow billing page shape. It takes no input. */
export async function activenowBillingShapeExport(deps: BillingShapeDeps, input: unknown = {}): Promise<BillingShapeExport> {
  checkKeys(inputObject(input), []);
  const config = await deps.storage.loadConfig(deps.familyId);
  const targets = activityTargets(config).targets.filter((target) => target.account.service === "activenow");
  const accounts: BillingShapeAccount[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]!;
    const label = `account ${index + 1}`;
    const http = createHttp(deps.runtime);
    try {
      const row = await probeAccount(http, target, deps.runtime);
      accounts.push({ ...row, account: label });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isActiveNowBlock(error)) {
        accounts.push({ account: label, status: message, billingLink: null, skeleton: "" });
        break;
      }
      accounts.push({ account: label, status: message, billingLink: null, skeleton: "" });
    }
  }
  return withFetches(deps, { accounts });
}