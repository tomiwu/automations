import { countFetches, fakeRuntime } from "@automations/shared";
import type { Account, Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { billingCandidates, maskPath, mondoBillingShapeExport, navEntries } from "./mondo-billing-shape.ts";
import { CHILD1, FAMILY_ID, activeNowAccount, choirActivity, readOnlyStorage, testConfig } from "./test-fixtures.ts";

const ORIGIN = "https://mondo.example.org";
const HASH = "ab12cd34ef56";
const SECRETS = { CHILD1_MONDO_LOGIN: "child@example.org", CHILD1_MONDO_PASSWORD: "pass&word" };

const picker = (selected: boolean): string =>
  `<button ${selected ? "" : `onclick="window.location.href='/auth/set-student/${HASH}'"`}><img src="/parent/photo-children/${HASH}?r=1"><span>Child One</span></button>`;

const NAV = `<header><nav>
<a href="/parent/payments?student=${HASH}" class="x">Płatności</a>
<a href="/parent/settlements/${HASH}">Rozliczenie</a>
<a href="https://other.example.com/payments">Płatności</a>
<a href="https://mondo.example.org/parent/messages">Wiadomości</a>
<a href="/logout">Wyloguj</a>
<a href="mailto:parent@example.org">Example Parent</a>
<span onclick="window.location.href='/parent/xhr-invoices/${HASH}'">Faktury</span>
<form action="/parent/agreements"></form>
<a href="/parent/calendar/2025">Kalendarz</a>
</nav></header><main><p>Example text 123</p></main>`;

const PANEL = (selected = true, nav = NAV): string => `${picker(selected)}${nav}`;

type Answer = { status?: number; body?: string; type?: string };
type Answers = Record<string, Answer>;

const happy = (selected = true, nav = NAV): Answers => ({
  "POST /login": { body: PANEL(selected, nav) },
  [`GET /auth/set-student/${HASH}`]: { body: "ok" },
  "GET /parent/payments": { body: "<body><h1>Płatności</h1><p>120,50 zł</p></body>", type: "text/html; charset=UTF-8" },
  [`GET /parent/settlements/${HASH}`]: { body: '{"rows":[{"amount":"10,00 zł"}]}', type: "application/json" },
  [`GET /parent/xhr-invoices/${HASH}`]: { body: "<table><tr><td>Faktura</td></tr></table>", type: "text/html" },
});

function mondoAccount(overrides: Partial<Account> = {}): Account {
  return {
    ...activeNowAccount,
    id: "00000000-0000-4000-8000-0000000000a3",
    service: "mondo",
    origin: ORIGIN,
    group: "Child One",
    login_secret: "CHILD1_MONDO_LOGIN",
    password_secret: "CHILD1_MONDO_PASSWORD",
    ...overrides,
  };
}

function configOf(...accounts: Account[]): Config {
  return {
    ...testConfig(),
    accounts,
    activities: accounts.map((account) => ({ ...choirActivity, account_id: account.id })),
  };
}

function setup(answers: Answers, config: Config = configOf(mondoAccount())) {
  const runtime = fakeRuntime({
    secrets: SECRETS,
    now: new Date("2026-10-20T08:00:00Z"),
    respond: (input, init) => {
      const answer = answers[`${init?.method ?? "GET"} ${new URL(input).pathname}`] ?? { status: 404, body: "missing" };
      return new Response(answer.body ?? "", { status: answer.status ?? 200, headers: { "content-type": answer.type ?? "text/html" } });
    },
  });
  const counter = countFetches(runtime.fetch);
  const deps = { runtime: { ...runtime, fetch: counter.fetch }, storage: readOnlyStorage(config), familyId: FAMILY_ID, counter };
  return { runtime, deps };
}

const requested = (runtime: { requests: { input: string; init?: { method?: string } }[] }): string[] =>
  runtime.requests.map((request) => `${request.init?.method ?? "GET"} ${new URL(request.input).pathname}`);

describe("mondoBillingShapeExport", () => {
  it("rejects unknown input keys", async () => {
    const { deps } = setup(happy());
    await expect(mondoBillingShapeExport(deps, { extra: 1 })).rejects.toThrow(/Unknown input key/);
  });

  it("sends the login and at most 3 candidate requests from links, forms and onclick paths", async () => {
    const { deps, runtime } = setup(happy());
    const result = await mondoBillingShapeExport(deps, {});
    expect(requested(runtime)).toEqual([
      "POST /login",
      "GET /parent/payments",
      `GET /parent/settlements/${HASH}`,
      `GET /parent/xhr-invoices/${HASH}`,
    ]);
    expect(result.accounts[0]?.candidates?.map((c) => c.status)).toEqual([200, 200, 200]);
    expect(result.fetches?.total).toBe(4);
  });

  it("never fetches a cross-origin link or the logout link", async () => {
    const { deps, runtime } = setup(happy());
    await mondoBillingShapeExport(deps, {});
    const inputs = runtime.requests.map((request) => request.input);
    expect(inputs.every((input) => input.startsWith(ORIGIN))).toBe(true);
    expect(inputs.some((input) => input.includes("logout") || input.includes("other.example.com"))).toBe(false);
  });

  it("selects the child first when it is not selected", async () => {
    const { deps, runtime } = setup(happy(false));
    await mondoBillingShapeExport(deps, {});
    expect(requested(runtime).slice(0, 2)).toEqual(["POST /login", `GET /auth/set-student/${HASH}`]);
    expect(requested(runtime)).toHaveLength(5);
  });

  it("sends the XHR header only for an xhr path", async () => {
    const { deps, runtime } = setup(happy());
    await mondoBillingShapeExport(deps, {});
    const header = (path: string) =>
      new Headers(runtime.requests.find((request) => request.input.endsWith(path))?.init?.headers).get("x-requested-with");
    expect(header(`/parent/xhr-invoices/${HASH}`)).toBe("XMLHttpRequest");
    expect(header("/parent/payments?student=" + HASH)).toBeNull();
  });

  it("returns the nav, the candidate reads and the navigation skeleton", async () => {
    const { deps } = setup(happy());
    const account = (await mondoBillingShapeExport(deps, {})).accounts[0]!;
    expect(account.account).toBe("account 1");
    expect(account.nav).toContainEqual({ path: "/parent/payments?student", label: "Płatności" });
    expect(account.nav).toContainEqual({ path: "/parent/xhr-invoices/<id>" });
    expect(account.nav).toContainEqual({ path: "/parent/calendar/<n>", label: "Kalendarz" });
    expect(account.nav).toContainEqual({ path: "/parent/agreements" });
    expect(account.candidates?.[0]).toEqual({
      path: "/parent/payments?student",
      status: 200,
      finalPath: "/parent/payments?student",
      contentType: "text/html; charset=UTF-8",
      skeleton: "<h1>Płatności</h1><p><amount></p>",
    });
    expect(account.candidates?.[1]?.skeleton).toBe('{"rows":{"$length":1,"$item":{"amount":"<amount>"}}}');
    expect(account.skeleton).toContain("Płatności");
    expect(account.skeleton).not.toContain("Example text");
    expect(account.skeleton).not.toContain("Child One");
  });

  it("uses the whole body when the page has no navigation area", async () => {
    const { deps } = setup(happy(true, '<p>Example text 123</p><a href="/parent/payments">Płatności</a>'));
    const account = (await mondoBillingShapeExport(deps, {})).accounts[0]!;
    expect(account.skeleton).toContain("<text>");
    expect(account.skeleton).toContain("Płatności");
  });

  it("records a 404 candidate and runs the next one", async () => {
    const answers = { ...happy(), "GET /parent/payments": { status: 404, body: "<p>Example missing</p>" } };
    const { deps, runtime } = setup(answers);
    const result = await mondoBillingShapeExport(deps, {});
    expect(result.accounts[0]?.candidates?.map((c) => c.status)).toEqual([404, 200, 200]);
    expect(requested(runtime)).toHaveLength(4);
  });

  it("stops the whole probe on a 403 candidate", async () => {
    const second = mondoAccount({ id: "00000000-0000-4000-8000-0000000000a4", origin: "https://mondo2.example.org" });
    const answers = { ...happy(), "GET /parent/payments": { status: 403, body: "<p>Forbidden</p>" } };
    const { deps, runtime } = setup(answers, configOf(mondoAccount(), second));
    const result = await mondoBillingShapeExport(deps, {});
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.candidates?.map((c) => c.status)).toEqual([403]);
    expect(requested(runtime)).toEqual(["POST /login", "GET /parent/payments"]);
  });

  it("stops the whole probe on a 403 login and hides the host", async () => {
    const second = mondoAccount({ id: "00000000-0000-4000-8000-0000000000a4", origin: "https://mondo2.example.org" });
    const { deps, runtime } = setup({ "POST /login": { status: 403, body: "no" } }, configOf(mondoAccount(), second));
    const result = await mondoBillingShapeExport(deps, {});
    expect(result.accounts).toEqual([{ account: "account 1", status: "Mondo: login rejected (HTTP 403, check credentials)" }]);
    expect(requested(runtime)).toEqual(["POST /login"]);
  });

  it("stops the whole probe on a 403 child selection", async () => {
    const answers = { ...happy(false), [`GET /auth/set-student/${HASH}`]: { status: 403, body: "no" } };
    const { deps } = setup(answers);
    const result = await mondoBillingShapeExport(deps, {});
    expect(result.accounts[0]?.status).toContain("HTTP 403");
  });

  it("hides the child name and the host in an error", async () => {
    const config = configOf(mondoAccount({ group: "Child Missing" }));
    const { deps } = setup(happy(), config);
    const result = await mondoBillingShapeExport(deps, {});
    expect(result.accounts[0]?.status).toBe("Mondo: child <hidden> not found in the parent panel");
    expect(result.accounts).toHaveLength(1);
  });

  it("masks the child hash and every fake value in the result", async () => {
    const { deps } = setup(happy());
    const text = JSON.stringify((await mondoBillingShapeExport(deps, {})).accounts);
    for (const fake of [HASH, "ab12", "Child One", "parent@example.org", "120,50", "child@example.org", "pass&word", "mondo.example.org"]) {
      expect(text).not.toContain(fake);
    }
  });

  it("writes nothing and gives no accounts without a Mondo Account", async () => {
    const { deps, runtime } = setup(happy(), configOf(activeNowAccount));
    const result = await mondoBillingShapeExport(deps, {});
    expect(result.accounts).toEqual([]);
    expect(runtime.requests).toEqual([]);
    expect(CHILD1).toBeDefined();
  });
});

describe("navEntries and billingCandidates", () => {
  const entries = (html: string) => navEntries(html, ORIGIN, HASH);

  it("keeps same-origin paths only, without duplicates", () => {
    const html =
      '<a href="/a/payments">Płatności</a><a href="/a/payments">Płatności</a><a href="//evil.example.net/x">x</a>' +
      '<a href="#top">Top</a><a href="javascript:void(0)">js</a><div data-href="/b">b</div><div data-url="/c" data-action-url="/d"></div>';
    expect(entries(html).map((entry) => entry.raw)).toEqual(["/a/payments", "/b", "/c", "/d"]);
  });

  it("labels links from the allowlist, else <text>, and gives no label to other nodes", () => {
    const html = '<a href="/a">Płatności</a><a href="/b">Example Person</a><form action="/c"></form>';
    expect(entries(html).map((entry) => entry.label)).toEqual(["Płatności", "<text>", undefined]);
  });

  it("selects billing candidates by path or label, three at most, one for each path", () => {
    const html =
      '<a href="/x/one">Płatności</a><a href="/invoices">Example</a><a href="/invoices">Faktury</a><a href="/set-student/payments">Płatności</a>' +
      '<a href="/p/saldo">Example</a><a href="/umowy">Example</a><a href="/nothing">Zajęcia</a>';
    expect(billingCandidates(entries(html)).map((entry) => entry.raw)).toEqual(["/x/one", "/invoices", "/p/saldo"]);
  });

  it("masks the hash even when it has no digit", () => {
    expect(maskPath("/parent/xhr-activity/abcdefghijkl?x=1", "abcdefghijkl")).toBe("/parent/xhr-activity/<id>?x");
  });
});
