import { createMemoryStorage } from "@automations/librus-data";
import { countFetches, fakeRuntime } from "@automations/shared";
import type { Account, Activity, Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { ACTIVE_NOW_BLOCK } from "./activenow-source.ts";
import { activenowBillingShapeExport } from "./activenow-billing-shape.ts";
import {
  CHILD1,
  CHILD2,
  FAMILY_ID,
  SECRETS,
  activeNowAccount,
  choirActivity,
  danceActivity,
  eduskyAccount,
  testConfig,
} from "./test-fixtures.ts";
import { readFileSync } from "node:fs";

const billingFixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const LOGIN_FORM =
  '<form action="/users/sign_in"><input type="hidden" name="authenticity_token" value="tok" /><input name="user[email]" /><input type="password" name="user[password]" /></form>';
const PICKER =
  '<meta name="csrf-token" content="csrf1"><a href="/role_selector/change_role?school_user_id=1&amp;user_equivalent_id=3"><p>Child One</p></a>';
const PANEL_WITH_BILLING =
  '<nav><a href="/client_panel/billing?account_id=42" class="nav-link">Rozliczenia</a></nav><label class="toggle">Pokaż nadchodzące</label>';
const BILLING_PAGE = billingFixture("activenow-billing-synthetic.html");
const BLOCKED = billingFixture("activenow-blocked.html");

const NOW_ACCOUNT2 = "00000000-0000-4000-8000-0000000000a3";

type Answer = { status?: number; location?: string; body?: string; cookie?: string };

function configWithSecondNow(): Config {
  const second: Account = {
    ...activeNowAccount,
    id: NOW_ACCOUNT2,
    child_id: CHILD2,
    group: "Child Two",
    login_secret: "CHILD2_ACTIVENOW_LOGIN",
    password_secret: "CHILD2_ACTIVENOW_PASSWORD",
  };
  const act2: Activity = {
    ...choirActivity,
    id: "00000000-0000-4000-8000-0000000000d3",
    child_id: CHILD2,
    account_id: NOW_ACCOUNT2,
    name: "Dance",
  };
  const base = testConfig();
  return {
    ...base,
    accounts: [activeNowAccount, second, eduskyAccount],
    activities: [choirActivity, act2, danceActivity],
  };
}

function storageOf(config: Config = testConfig()) {
  return createMemoryStorage({ configs: [config] });
}

function setup(answers: Record<string, Answer>, config: Config = testConfig()) {
  const runtime = fakeRuntime({
    secrets: { ...SECRETS, CHILD2_ACTIVENOW_LOGIN: "login-two", CHILD2_ACTIVENOW_PASSWORD: "password two" },
    now: new Date("2026-10-20T08:00:00Z"),
    respond: (input, init) => {
      const path = new URL(input).pathname;
      const key = `${init?.method ?? "GET"} ${path}`;
      const answer = answers[key] ?? { status: 404, body: "missing" };
      const headers = new Headers();
      if (answer.location) headers.set("location", answer.location);
      if (answer.cookie) headers.append("set-cookie", `${answer.cookie}; path=/; HttpOnly`);
      return new Response(answer.body ?? "", { status: answer.status ?? 200, headers });
    },
  });
  const counter = countFetches(runtime.fetch);
  const counting = { ...runtime, fetch: counter.fetch };
  return {
    runtime,
    counter,
    deps: { runtime: counting, storage: storageOf(config), familyId: FAMILY_ID, counter },
  };
}

const happy: Record<string, Answer> = {
  "GET /users/sign_in": { body: LOGIN_FORM, cookie: "pre=1" },
  "POST /users/sign_in": { body: PICKER, cookie: "sess=abc" },
  "POST /role_selector/change_role": { body: PANEL_WITH_BILLING },
  "GET /client_panel/billing": { body: BILLING_PAGE },
};

describe("activenowBillingShapeExport", () => {
  it("rejects unknown input keys", async () => {
    const { deps } = setup(happy);
    await expect(activenowBillingShapeExport(deps, { extra: true })).rejects.toThrow(/Unknown input key/);
  });

  it("sends login, profile and billing requests in order", async () => {
    const { deps, runtime } = setup(happy);
    await activenowBillingShapeExport(deps, {});
    expect(runtime.requests.map((r) => `${r.init?.method ?? "GET"} ${new URL(r.input).pathname}`)).toEqual([
      "GET /users/sign_in",
      "POST /users/sign_in",
      "POST /role_selector/change_role",
      "GET /client_panel/billing",
    ]);
  });

  it("gives billing link, status, skeleton and fetch counts", async () => {
    const { deps } = setup(happy);
    const result = await activenowBillingShapeExport(deps, {});
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]).toMatchObject({
      account: "account 1",
      billingLink: "/client_panel/billing?account_id",
      billingStatus: 200,
    });
    expect(result.accounts[0]?.skeleton).toContain("Rozliczenia");
    expect(result.fetches?.total).toBe(4);
  });

  it("sends no billing request when Rozliczenia is missing", async () => {
    const { deps, runtime } = setup({
      ...happy,
      "POST /role_selector/change_role": { body: "<nav><a href='/events'>Zajęcia</a></nav>" },
    });
    const result = await activenowBillingShapeExport(deps, {});
    expect(result.accounts[0]?.billingLink).toBeNull();
    expect(result.accounts[0]?.skeleton).toContain("/events");
    expect(runtime.requests.some((r) => r.input.includes("/client_panel/billing"))).toBe(false);
  });

  it("stops the probe on a block page and asks for no second Account", async () => {
    const { deps, runtime } = setup({ ...happy, "GET /users/sign_in": { status: 403, body: BLOCKED } }, configWithSecondNow());
    const result = await activenowBillingShapeExport(deps, {});
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.status).toBe(ACTIVE_NOW_BLOCK);
    expect(runtime.requests).toHaveLength(1);
  });

  it("records a login rejection for one Account and still runs the others", async () => {
    let loginPosts = 0;
    const answers = { ...happy };
    const runtime = fakeRuntime({
      secrets: { ...SECRETS, CHILD2_ACTIVENOW_LOGIN: "login-two", CHILD2_ACTIVENOW_PASSWORD: "password two" },
      now: new Date("2026-10-20T08:00:00Z"),
      respond: (input, init) => {
        const path = new URL(input).pathname;
        const key = `${init?.method ?? "GET"} ${path}`;
        const answer =
          key === "POST /users/sign_in"
            ? loginPosts++ === 0
              ? { body: LOGIN_FORM }
              : { body: PANEL_WITH_BILLING }
            : (answers[key] ?? { status: 404, body: "missing" });
        const headers = new Headers();
        if (answer.location) headers.set("location", answer.location);
        if (answer.cookie) headers.append("set-cookie", `${answer.cookie}; path=/; HttpOnly`);
        return new Response(answer.body ?? "", { status: answer.status ?? 200, headers });
      },
    });
    const counter = countFetches(runtime.fetch);
    const deps = {
      runtime: { ...runtime, fetch: counter.fetch },
      storage: storageOf(configWithSecondNow()),
      familyId: FAMILY_ID,
      counter,
    };
    const result = await activenowBillingShapeExport(deps, {});
    expect(result.accounts).toHaveLength(2);
    expect(result.accounts[0]?.status).toMatch(/login rejected/);
    expect(result.accounts[1]?.billingLink).toBe("/client_panel/billing?account_id");
  });
});