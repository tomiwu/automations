import * as cheerio from "cheerio";
import type { FetchCount, FetchCounter, Runtime } from "@automations/shared";
import { formatFetchCount } from "@automations/shared";
import { checked, isActiveNowBlock, openActiveNowPanel } from "./activenow-source.ts";
import { bodySkeleton, redactPaths, redactUrl } from "./activenow-billing-redact.ts";
import { checkKeys, inputObject } from "./exports.ts";
import { createHttp } from "./http.ts";
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
  billingStatus?: number;
  /** The redacted path of the billing page after the redirects. */
  finalPath?: string;
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

/**
 * Gives a runtime that remembers the last address it fetched. The session follows redirects by hand, so the
 * last address is the final address of the last page.
 */
function trackLastUrl(runtime: Runtime): { runtime: Runtime; lastUrl: () => string } {
  let last = "";
  const fetch: Runtime["fetch"] = (input, init) => {
    last = String(input);
    return runtime.fetch(input, init);
  };
  return { runtime: { ...runtime, fetch }, lastUrl: () => last };
}

async function probeAccount(target: ActivityTarget, runtime: Runtime): Promise<BillingShapeAccount> {
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
  return {
    account: "",
    billingLink: redactUrl(billing),
    billingStatus: page.status,
    finalPath: redactUrl(tracked.lastUrl()),
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
    try {
      const row = await probeAccount(target, deps.runtime);
      accounts.push({ ...row, account: label });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      accounts.push({ account: label, status: redactPaths(message), billingLink: null, skeleton: "" });
      if (isActiveNowBlock(error)) break;
    }
  }
  return withFetches(deps, { accounts });
}