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
const SETTLEMENTS_INDEX = "/client_panel/settlements/index";
const BILLING_SETTLEMENTS = billingFixture("activenow-billing-settlements.html");
const UPCOMING_BODY = '<turbo-stream action="append"><template><tr><td><date></td></tr></template></turbo-stream>';
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

const happySettlements: Record<string, Answer> = {
  ...happy,
  "GET /client_panel/billing": { status: 302, location: SETTLEMENTS_INDEX },
  "GET /client_panel/settlements/index": { body: BILLING_SETTLEMENTS },
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

  it("gives the redacted final path of the billing page after a redirect", async () => {
    const { deps, runtime } = setup({
      ...happy,
      "GET /client_panel/billing": { status: 302, location: "/client_panel/billing/accounts/998877/payments" },
      "GET /client_panel/billing/accounts/998877/payments": { body: BILLING_PAGE },
    });
    const result = await activenowBillingShapeExport(deps, {});
    expect(result.accounts[0]?.finalPath).toBe("/client_panel/billing/accounts/<n>/payments");
    expect(JSON.stringify(result)).not.toContain("998877");
    expect(runtime.requests).toHaveLength(5);
  });

  it("GETs upcoming from markup when exactly one upcoming-url-value is present", async () => {
    const { deps, runtime } = setup({
      ...happySettlements,
      "GET /client_panel/settlements/upcoming": { body: UPCOMING_BODY },
    });
    const result = await activenowBillingShapeExport(deps, {});
    expect(result.accounts[0]?.upcoming).toMatchObject({
      source: "markup",
      status: 200,
      path: "/client_panel/settlements/upcoming?x",
    });
    expect(result.accounts[0]?.upcoming?.skeleton).toContain("turbo-stream");
    expect(result.accounts[0]?.head?.scripts.length).toBeGreaterThan(0);
    expect(runtime.requests.map((r) => `${r.init?.method ?? "GET"} ${new URL(r.input).pathname}`)).toEqual([
      "GET /users/sign_in",
      "POST /users/sign_in",
      "POST /role_selector/change_role",
      "GET /client_panel/billing",
      "GET /client_panel/settlements/index",
      "GET /client_panel/settlements/upcoming",
    ]);
    expect(result.fetches?.total).toBe(6);
  });

  it("finds upcoming from the settlements JS module when markup has no path", async () => {
    const settlementsNoMarkup = billingFixture("activenow-billing-settlements-importmap.html");
    const jsModule =
      'export default class extends Controller { load() { fetch("/client_panel/settlements/index?upcoming=true"); } }';
    const answers: Record<string, Answer> = {
      "GET /users/sign_in": { body: LOGIN_FORM, cookie: "pre=1" },
      "POST /users/sign_in": { body: PICKER, cookie: "sess=abc" },
      "POST /role_selector/change_role": { body: PANEL_WITH_BILLING },
      "GET /client_panel/billing": { status: 302, location: SETTLEMENTS_INDEX },
      "GET /client_panel/settlements/index": { body: settlementsNoMarkup },
      "GET /assets/settlements-fake.js": { body: jsModule },
    };
    const runtime = fakeRuntime({
      secrets: SECRETS,
      now: new Date("2026-10-20T08:00:00Z"),
      respond: (input, init) => {
        const url = new URL(input);
        if (url.search.includes("upcoming=true")) {
          return new Response(UPCOMING_BODY, {
            status: 200,
            headers: { "content-type": "text/vnd.turbo-stream.html" },
          });
        }
        const key = `${init?.method ?? "GET"} ${url.pathname}`;
        const answer = answers[key] ?? { status: 404, body: "missing" };
        const headers = new Headers();
        if (answer.location) headers.set("location", answer.location);
        if (answer.cookie) headers.append("set-cookie", `${answer.cookie}; path=/; HttpOnly`);
        return new Response(answer.body ?? "", { status: answer.status ?? 200, headers });
      },
    });
    const counter = countFetches(runtime.fetch);
    const deps = {
      runtime: { ...runtime, fetch: counter.fetch },
      storage: storageOf(),
      familyId: FAMILY_ID,
      counter,
    };
    const result = await activenowBillingShapeExport(deps, {});
    expect(result.accounts[0]?.upcoming?.source).toBe("javascript");
    expect(result.accounts[0]?.upcoming?.path).toMatch(/upcoming/);
    const paths = runtime.requests.map((r) => new URL(r.input).pathname);
    expect(paths.filter((p) => p.includes("settlements-fake"))).toHaveLength(1);
    expect(runtime.requests.some((r) => r.input.includes("upcoming"))).toBe(true);
  });

  it("skips upcoming GET when the JS module names two upcoming paths", async () => {
    const settlementsNoMarkup = billingFixture("activenow-billing-settlements-importmap.html");
    const jsModule = 'fetch("/client_panel/settlements/upcoming-a"); fetch("/client_panel/settlements/upcoming-b")';
    const { deps, runtime } = setup({
      "GET /users/sign_in": { body: LOGIN_FORM, cookie: "pre=1" },
      "POST /users/sign_in": { body: PICKER, cookie: "sess=abc" },
      "POST /role_selector/change_role": { body: PANEL_WITH_BILLING },
      "GET /client_panel/billing": { status: 302, location: SETTLEMENTS_INDEX },
      "GET /client_panel/settlements/index": { body: settlementsNoMarkup },
      "GET /assets/settlements-fake.js": { body: jsModule },
    });
    const result = await activenowBillingShapeExport(deps, {});
    expect(result.accounts[0]?.upcoming?.source).toBe(null);
    expect(result.accounts[0]?.upcoming?.reason).toMatch(/ambiguous/i);
    expect(runtime.requests.some((r) => new URL(r.input).pathname.includes("upcoming-a"))).toBe(false);
  });

  it("finds a single non-index path literal in the JS module", async () => {
    const settlementsNoMarkup = billingFixture("activenow-billing-settlements-importmap.html");
    const jsModule = 'export default class extends Controller { visit("/client_panel/settlements/preview") }';
    const { deps, runtime } = setup({
      "GET /users/sign_in": { body: LOGIN_FORM, cookie: "pre=1" },
      "POST /users/sign_in": { body: PICKER, cookie: "sess=abc" },
      "POST /role_selector/change_role": { body: PANEL_WITH_BILLING },
      "GET /client_panel/billing": { status: 302, location: SETTLEMENTS_INDEX },
      "GET /client_panel/settlements/index": { body: settlementsNoMarkup },
      "GET /assets/settlements-fake.js": { body: jsModule },
      "GET /client_panel/settlements/preview": { body: UPCOMING_BODY },
    });
    const result = await activenowBillingShapeExport(deps, {});
    expect(result.accounts[0]?.upcoming?.source).toBe("javascript");
    expect(result.accounts[0]?.upcoming?.path).toBe("/client_panel/settlements/preview");
    expect(runtime.requests.some((r) => new URL(r.input).pathname.endsWith("/preview"))).toBe(true);
  });

  it("skips upcoming GET when the JS module has only the index path", async () => {
    const settlementsNoMarkup = billingFixture("activenow-billing-settlements-importmap.html");
    const jsModule = 'visit("/client_panel/settlements/index")';
    const { deps, runtime } = setup({
      "GET /users/sign_in": { body: LOGIN_FORM, cookie: "pre=1" },
      "POST /users/sign_in": { body: PICKER, cookie: "sess=abc" },
      "POST /role_selector/change_role": { body: PANEL_WITH_BILLING },
      "GET /client_panel/billing": { status: 302, location: SETTLEMENTS_INDEX },
      "GET /client_panel/settlements/index": { body: settlementsNoMarkup },
      "GET /assets/settlements-fake.js": { body: jsModule },
    });
    const result = await activenowBillingShapeExport(deps, {});
    expect(result.accounts[0]?.upcoming?.source).toBe(null);
    expect(runtime.requests.some((r) => new URL(r.input).search.includes("upcoming"))).toBe(false);
  });

  it("skips upcoming GET when two candidate paths exist", async () => {
    const twoPaths = `<html><head></head><body>
      <div data-controller="client-panel-page-settlements"
        data-a-url-value="/client_panel/settlements/upcoming"
        data-b-url-value="/client_panel/settlements/other"></div></body></html>`;
    const { deps, runtime } = setup({
      ...happy,
      "GET /client_panel/billing": { status: 302, location: SETTLEMENTS_INDEX },
      "GET /client_panel/settlements/index": { body: twoPaths },
    });
    const result = await activenowBillingShapeExport(deps, {});
    expect(result.accounts[0]?.upcoming).toMatchObject({
      source: null,
      reason: "ambiguous upcoming paths in markup",
    });
    expect(runtime.requests.some((r) => new URL(r.input).pathname.includes("upcoming"))).toBe(false);
  });

  it("uses the JS module when markup paths are ambiguous", async () => {
    const twoPaths = billingFixture("activenow-billing-settlements-importmap.html").replace(
      "</body>",
      '<div data-controller="client-panel-page-settlements" data-a-url-value="/client_panel/settlements/upcoming" data-b-url-value="/client_panel/settlements/other"></div></body>',
    );
    const jsModule = 'fetch("/client_panel/settlements/index?upcoming=true")';
    const runtime = fakeRuntime({
      secrets: SECRETS,
      now: new Date("2026-10-20T08:00:00Z"),
      respond: (input, init) => {
        const url = new URL(input);
        if (url.search.includes("upcoming=true")) {
          return new Response(UPCOMING_BODY, {
            status: 200,
            headers: { "content-type": "text/vnd.turbo-stream.html" },
          });
        }
        const key = `${init?.method ?? "GET"} ${url.pathname}`;
        const answers: Record<string, Answer> = {
          "GET /users/sign_in": { body: LOGIN_FORM, cookie: "pre=1" },
          "POST /users/sign_in": { body: PICKER, cookie: "sess=abc" },
          "POST /role_selector/change_role": { body: PANEL_WITH_BILLING },
          "GET /client_panel/billing": { status: 302, location: SETTLEMENTS_INDEX },
          "GET /client_panel/settlements/index": { body: twoPaths },
          "GET /assets/settlements-fake.js": { body: jsModule },
        };
        const answer = answers[key] ?? { status: 404, body: "missing" };
        const headers = new Headers();
        if (answer.location) headers.set("location", answer.location);
        if (answer.cookie) headers.append("set-cookie", `${answer.cookie}; path=/; HttpOnly`);
        return new Response(answer.body ?? "", { status: answer.status ?? 200, headers });
      },
    });
    const counter = countFetches(runtime.fetch);
    const deps = {
      runtime: { ...runtime, fetch: counter.fetch },
      storage: storageOf(),
      familyId: FAMILY_ID,
      counter,
    };
    const result = await activenowBillingShapeExport(deps, {});
    expect(result.accounts[0]?.upcoming?.source).toBe("javascript");
    expect(runtime.requests.some((r) => new URL(r.input).search.includes("upcoming"))).toBe(true);
  });

  it("records a non-2xx upcoming GET without stopping the probe", async () => {
    const { deps } = setup({
      ...happySettlements,
      "GET /client_panel/settlements/upcoming": { status: 404, body: "missing" },
    });
    const result = await activenowBillingShapeExport(deps, {});
    expect(result.accounts[0]?.upcoming).toMatchObject({ source: "markup", status: 404 });
    expect(result.accounts[0]?.status).toBeUndefined();
  });

  it("fetches the settlements JS module only once for two Accounts", async () => {
    const settlementsNoMarkup = billingFixture("activenow-billing-settlements-importmap.html");
    const jsModule = 'fetch("/client_panel/settlements/index?upcoming=true")';
    let moduleGets = 0;
    const runtime = fakeRuntime({
      secrets: { ...SECRETS, CHILD2_ACTIVENOW_LOGIN: "login-two", CHILD2_ACTIVENOW_PASSWORD: "password two" },
      now: new Date("2026-10-20T08:00:00Z"),
      respond: (input, init) => {
        const path = new URL(input).pathname;
        const search = new URL(input).search;
        if (path === "/assets/settlements-fake.js") {
          moduleGets += 1;
          return new Response(jsModule, { status: 200 });
        }
        if (search.includes("upcoming")) return new Response(UPCOMING_BODY, { status: 200 });
        const key = `${init?.method ?? "GET"} ${path}`;
        const answers: Record<string, Answer> = {
          "GET /users/sign_in": { body: LOGIN_FORM, cookie: "pre=1" },
          "POST /users/sign_in": { body: PICKER, cookie: "sess=abc" },
          "POST /role_selector/change_role": { body: PANEL_WITH_BILLING },
          "GET /client_panel/billing": { status: 302, location: SETTLEMENTS_INDEX },
          "GET /client_panel/settlements/index": { body: settlementsNoMarkup },
        };
        const answer = answers[key] ?? { status: 404, body: "missing" };
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
    await activenowBillingShapeExport(deps, {});
    expect(moduleGets).toBe(1);
  });

  it("records a 404 on the JS module and still runs the next Account", async () => {
    const settlementsNoMarkup = billingFixture("activenow-billing-settlements-importmap.html");
    const twoChildPicker =
      '<meta name="csrf-token" content="csrf1"><a href="/role_selector/change_role?school_user_id=1"><p>Child One</p></a><a href="/role_selector/change_role?school_user_id=2"><p>Child Two</p></a>';
    let moduleGets = 0;
    const runtime = fakeRuntime({
      secrets: { ...SECRETS, CHILD2_ACTIVENOW_LOGIN: "login-two", CHILD2_ACTIVENOW_PASSWORD: "password two" },
      now: new Date("2026-10-20T08:00:00Z"),
      respond: (input, init) => {
        const path = new URL(input).pathname;
        if (path === "/assets/settlements-fake.js") {
          moduleGets += 1;
          return new Response("missing", { status: 404 });
        }
        const key = `${init?.method ?? "GET"} ${path}`;
        const answers: Record<string, Answer> = {
          "GET /users/sign_in": { body: LOGIN_FORM, cookie: "pre=1" },
          "POST /users/sign_in": { body: twoChildPicker, cookie: "sess=abc" },
          "POST /role_selector/change_role": { body: PANEL_WITH_BILLING },
          "GET /client_panel/billing": { status: 302, location: SETTLEMENTS_INDEX },
          "GET /client_panel/settlements/index": { body: settlementsNoMarkup },
        };
        const answer = answers[key] ?? { status: 404, body: "missing" };
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
    expect(result.accounts[0]?.upcoming?.source).toBe(null);
    expect(result.accounts[0]?.upcoming?.reason).toMatch(/404|module/i);
    expect(result.accounts[1]?.billingLink).toBeTruthy();
    expect(moduleGets).toBe(1);
  });

  it("stops the probe on 403 from the upcoming GET", async () => {
    const { deps, runtime } = setup({
      ...happySettlements,
      "GET /client_panel/settlements/upcoming": { status: 403, body: BLOCKED },
    });
    const result = await activenowBillingShapeExport(deps, {});
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.status).toBe(ACTIVE_NOW_BLOCK);
    expect(runtime.requests.at(-1)?.input).toContain("upcoming");
  });

  it("masks the numbers of a path in an error message", async () => {
    const { deps } = setup({
      ...happy,
      "POST /role_selector/change_role": { body: '<nav><a href="/client_panel/billing/accounts/55">Rozliczenia</a></nav>' },
    });
    const result = await activenowBillingShapeExport(deps, {});
    expect(result.accounts[0]?.status).toBe("ActiveNow: HTTP 404 from /client_panel/billing/accounts/<n>");
    expect(JSON.stringify(result)).not.toContain("55");
  });

  it("does not fetch a JS module from another origin", async () => {
    const crossOrigin = billingFixture("activenow-billing-settlements-importmap.html").replace(
      '"/assets/settlements-fake.js"',
      '"https://cdn.example.org/assets/settlements-fake.js"',
    );
    const { deps, runtime } = setup({
      "GET /users/sign_in": { body: LOGIN_FORM, cookie: "pre=1" },
      "POST /users/sign_in": { body: PICKER, cookie: "sess=abc" },
      "POST /role_selector/change_role": { body: PANEL_WITH_BILLING },
      "GET /client_panel/billing": { status: 302, location: SETTLEMENTS_INDEX },
      "GET /client_panel/settlements/index": { body: crossOrigin },
    });
    const result = await activenowBillingShapeExport(deps, {});
    expect(result.accounts[0]?.upcoming?.source).toBeNull();
    expect(runtime.requests.some((r) => r.input.includes("cdn.example.org"))).toBe(false);
  });

  it("stops the probe on a block page from the JS module", async () => {
    const settlementsNoMarkup = billingFixture("activenow-billing-settlements-importmap.html");
    const { deps, runtime } = setup(
      {
      "GET /users/sign_in": { body: LOGIN_FORM, cookie: "pre=1" },
      "POST /users/sign_in": { body: PICKER, cookie: "sess=abc" },
      "POST /role_selector/change_role": { body: PANEL_WITH_BILLING },
      "GET /client_panel/billing": { status: 302, location: SETTLEMENTS_INDEX },
        "GET /client_panel/settlements/index": { body: settlementsNoMarkup },
        "GET /assets/settlements-fake.js": { status: 403, body: BLOCKED },
      },
      configWithSecondNow(),
    );
    const result = await activenowBillingShapeExport(deps, {});
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.status).toBe(ACTIVE_NOW_BLOCK);
    expect(runtime.requests.filter((r) => new URL(r.input).pathname === "/users/sign_in")).toHaveLength(2);
  });

  it("puts the snippets about upcoming first and masks e-mails and digits in them", async () => {
    const settlementsNoMarkup = billingFixture("activenow-billing-settlements-importmap.html");
    const filler = "x".repeat(500);
    const jsModule = `import { fetch as f } from "x"; ${filler} const url = 1; ${filler} const src = 2; ${filler} // owner@example.org 12345
 this.upcomingValue = true; ${filler} visit("/client_panel/settlements/a"); visit("/client_panel/settlements/b")`;
    const { deps } = setup({
      "GET /users/sign_in": { body: LOGIN_FORM, cookie: "pre=1" },
      "POST /users/sign_in": { body: PICKER, cookie: "sess=abc" },
      "POST /role_selector/change_role": { body: PANEL_WITH_BILLING },
      "GET /client_panel/billing": { status: 302, location: SETTLEMENTS_INDEX },
      "GET /client_panel/settlements/index": { body: settlementsNoMarkup },
      "GET /assets/settlements-fake.js": { body: jsModule },
    });
    const result = await activenowBillingShapeExport(deps, {});
    const snippets = result.accounts[0]?.upcoming?.jsSnippets ?? [];
    expect(snippets[0]).toContain("upcoming");
    expect(snippets.join(" ")).not.toContain("owner@example.org");
    expect(snippets.join(" ")).not.toContain("12345");
  });
});
