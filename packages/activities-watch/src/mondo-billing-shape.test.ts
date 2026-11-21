import { countFetches, fakeRuntime } from "@automations/shared";
import type { Account, Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { followPlan, maskPath, mondoBillingShapeExport, navEntries, redactLiteral, scriptPaths, scriptSnippets } from "./mondo-billing-shape.ts";
import { FAMILY_ID, activeNowAccount, choirActivity, readOnlyStorage, testConfig } from "./test-fixtures.ts";

const ORIGIN = "https://mondo.example.org";
const HASH = "ab12cd34ef56";
const SECRETS = { CHILD1_MONDO_LOGIN: "child@example.org", CHILD1_MONDO_PASSWORD: "pass&word" };

const picker = (selected: boolean): string =>
  `<button ${selected ? "" : `onclick="window.location.href='/auth/set-student/${HASH}'"`}><img src="/parent/photo-children/${HASH}?r=1"><span>Child One</span></button>`;

const SCRIPT = `<script>
var email = "parent@example.org";
$.get('/parent/xhr-saldo/' + hash, function (r) { $('.nav-sub-saldo').html(r); });
</script>`;

const NAV = `<header><nav>
<a href="/parent/xhr-account">Konto</a>
<a href="/logout">Wyloguj</a>
<a href="/change-lang/en">EN</a>
<a href="https://other.example.com/payments">Płatności</a>
<a href="/parent/messages">Wiadomości</a>
</nav></header><main><p>Example text 123</p><div class="nav-sub-saldo"></div></main>${SCRIPT}`;

const PANEL = (selected = true, nav = NAV): string => `${picker(selected)}${nav}`;

type Answer = { status?: number; body?: string; type?: string };
type Answers = Record<string, Answer>;

const happy = (selected = true, nav = NAV): Answers => ({
  "POST /login": { body: PANEL(selected, nav) },
  [`GET /auth/set-student/${HASH}`]: { body: "ok" },
  "GET /parent/xhr-account": { body: '<div><a href="/parent/xhr-account">x</a><p>120,50 zł</p></div>', type: "text/html; charset=UTF-8" },
  [`GET /parent/xhr-activity/${HASH}`]: { body: '{"rows":[{"amount":"10,00 zł"}]}', type: "application/json" },
  [`GET /parent/xhr-saldo/${HASH}`]: { body: "<p>Saldo 10,00 zł</p>", type: "text/html" },
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

const readOnly = (runtime: { requests: { input: string }[] }): string[] => runtime.requests.map((request) => request.input);

describe("mondoBillingShapeExport", () => {
  it("rejects unknown input keys", async () => {
    const { deps } = setup(happy());
    await expect(mondoBillingShapeExport(deps, { extra: 1 })).rejects.toThrow(/Unknown input key/);
  });

  it("sends the login, the 2 XHR reads and one followed path from a script", async () => {
    const { deps, runtime } = setup(happy());
    const result = await mondoBillingShapeExport(deps, {});
    expect(requested(runtime)).toEqual([
      "POST /login",
      "GET /parent/xhr-account",
      `GET /parent/xhr-activity/${HASH}`,
      `GET /parent/xhr-saldo/${HASH}`,
    ]);
    expect(result.fetches?.total).toBe(4);
    expect(result.accounts[0]?.followed).toEqual([
      { path: "/parent/xhr-saldo/<id>", status: 200, contentType: "text/html", skeleton: expect.any(String) },
    ]);
  });

  it("sends the XHR header on the XHR reads and the followed path", async () => {
    const { deps, runtime } = setup(happy());
    await mondoBillingShapeExport(deps, {});
    const headers = runtime.requests.slice(1).map((request) => new Headers(request.init?.headers).get("x-requested-with"));
    expect(headers).toEqual(["XMLHttpRequest", "XMLHttpRequest", "XMLHttpRequest"]);
  });

  it("selects the child first when it is not selected, and keeps to 6 requests", async () => {
    const { deps, runtime } = setup(happy(false));
    await mondoBillingShapeExport(deps, {});
    expect(requested(runtime).slice(0, 2)).toEqual(["POST /login", `GET /auth/set-student/${HASH}`]);
    expect(requested(runtime).length).toBeLessThanOrEqual(6);
  });

  it("returns the XHR reads with masked paths, statuses, content types and skeletons", async () => {
    const { deps } = setup(happy());
    const account = (await mondoBillingShapeExport(deps, {})).accounts[0]!;
    expect(account.xhr).toEqual([
      { path: "/parent/xhr-account", status: 200, contentType: "text/html; charset=UTF-8", skeleton: expect.stringContaining("<amount>") },
      {
        path: "/parent/xhr-activity/<id>",
        status: 200,
        contentType: "application/json",
        skeleton: '{"rows":{"$length":1,"$item":{"amount":"<amount>"}}}',
      },
    ]);
    expect(account.nav).toContainEqual({ path: "/parent/xhr-account", label: "<text>" });
    expect(account.skeleton).not.toContain("Example text");
  });

  it("follows at most 2 new paths", async () => {
    const script = `<script>a('/parent/xhr-saldo/' + h); b('/parent/payments'); c('/parent/xhr-transakcje'); d('/parent/oplaty');</script>`;
    const answers = {
      ...happy(true, `<nav></nav>${script}`),
      "GET /parent/payments": { body: "<p>ok</p>" },
      "GET /parent/xhr-transakcje": { body: "<p>ok</p>" },
    };
    const { deps, runtime } = setup(answers);
    const account = (await mondoBillingShapeExport(deps, {})).accounts[0]!;
    expect(requested(runtime).slice(3)).toEqual([`GET /parent/xhr-saldo/${HASH}`, "GET /parent/payments"]);
    expect(account.followed).toHaveLength(2);
  });

  it("never fetches logout, login, set-student, change-lang or a cross-origin path", async () => {
    const script = `<script>a('/logout/payment'); b('/login/saldo'); c('/auth/set-student/payment'); d('/change-lang/saldo'); e('https://other.example.com/saldo'); f('//other.example.com/saldo');</script>`;
    const { deps, runtime } = setup(happy(true, `<nav></nav>${script}`));
    const account = (await mondoBillingShapeExport(deps, {})).accounts[0]!;
    expect(requested(runtime)).toHaveLength(3);
    expect(account.followed).toEqual([]);
    expect(readOnly(runtime).every((input) => input.startsWith(ORIGIN))).toBe(true);
  });

  it("does not fetch an XHR path again and finds paths in the attributes of the answers", async () => {
    const answers = {
      ...happy(),
      "GET /parent/xhr-account": { body: `<a href="/parent/xhr-account">a</a><a href="/parent/xhr-activity/${HASH}">b</a><a data-url="/parent/platnosci?x=1">c</a>` },
      "GET /parent/platnosci": { body: "<p>ok</p>" },
    };
    const { deps, runtime } = setup(answers);
    const account = (await mondoBillingShapeExport(deps, {})).accounts[0]!;
    expect(requested(runtime).slice(3)).toEqual([`GET /parent/xhr-saldo/${HASH}`, "GET /parent/platnosci"]);
    expect(account.followed?.map((entry) => entry.path)).toEqual(["/parent/xhr-saldo/<id>", "/parent/platnosci?x"]);
  });

  it("reports a skipped path that ends with / and has no variable", async () => {
    const script = `<script>x('/parent/xhr-saldo/' + 'abc'); y('/parent/xhr-other/');</script>`;
    const { deps, runtime } = setup(happy(true, `<nav></nav>${script}`));
    const account = (await mondoBillingShapeExport(deps, {})).accounts[0]!;
    expect(requested(runtime)).toHaveLength(3);
    expect(account.followed).toEqual([
      { path: "/parent/xhr-saldo/", reason: "path ends with / and no variable follows" },
      { path: "/parent/xhr-other/", reason: "path ends with / and no variable follows" },
    ]);
  });

  it("records a 404 on xhr-account and still reads xhr-activity", async () => {
    const answers = { ...happy(), "GET /parent/xhr-account": { status: 404, body: "<p>Example missing</p>" } };
    const { deps, runtime } = setup(answers);
    const account = (await mondoBillingShapeExport(deps, {})).accounts[0]!;
    expect(account.xhr?.map((read) => read.status)).toEqual([404, 200]);
    expect(requested(runtime)).toContain(`GET /parent/xhr-activity/${HASH}`);
  });

  it("stops the whole probe on a 403 XHR read", async () => {
    const second = mondoAccount({ id: "00000000-0000-4000-8000-0000000000a4", origin: "https://mondo2.example.org" });
    const answers = { ...happy(), "GET /parent/xhr-account": { status: 403, body: "<p>Forbidden</p>" } };
    const { deps, runtime } = setup(answers, configOf(mondoAccount(), second));
    const result = await mondoBillingShapeExport(deps, {});
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.xhr?.map((read) => read.status)).toEqual([403]);
    expect(requested(runtime)).toEqual(["POST /login", "GET /parent/xhr-account"]);
  });

  it("stops the whole probe on a 403 followed path", async () => {
    const second = mondoAccount({ id: "00000000-0000-4000-8000-0000000000a4", origin: "https://mondo2.example.org" });
    const answers = { ...happy(), [`GET /parent/xhr-saldo/${HASH}`]: { status: 403, body: "no" } };
    const { deps } = setup(answers, configOf(mondoAccount(), second));
    const result = await mondoBillingShapeExport(deps, {});
    expect(result.accounts).toHaveLength(1);
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
  });

  it("masks the snippets: hashes, e-mails, digits, names and the host", async () => {
    const script = `<script>
var name = "Example Child"; var mail = "parent@example.org"; var n = 12345; var host = "mondo.example.org";
var p = '/parent/xhr-saldo/${HASH}'; var q = "other-hash"; var code = "ab12";
$.get('/parent/xhr-saldo/' + hash); // Child One ${HASH}
</script>`;
    const other = `<button onclick="window.location.href='/auth/set-student/h-other'"><img src="/parent/photo-children/h-other"><span>Child Two</span></button>`;
    const answers = happy(true, `<nav></nav>${script}${other}`);
    answers["GET /parent/xhr-account"] = { body: `<script>load("/parent/xhr-saldo/h-other"); var s = 7;</script>` };
    const { deps } = setup(answers);
    const account = (await mondoBillingShapeExport(deps, {})).accounts[0]!;
    const text = JSON.stringify(account);
    expect(account.snippets?.length).toBeGreaterThan(0);
    expect(account.snippets?.every((snippet) => snippet.length <= 400)).toBe(true);
    expect(account.snippets?.join("\n")).toContain('"/parent/xhr-saldo/<id>"');
    expect(account.snippets?.join("\n")).toContain('"<text>"');
    for (const fake of [HASH, "h-other", "Example Child", "Child One", "parent@example.org", "12345", "mondo.example.org", "child@example.org", "pass&word"]) {
      expect(text).not.toContain(fake);
    }
  });

  it("masks a child hash without a digit in the skeletons", async () => {
    const nav = '<nav><a href="/parent/xhr-account/h-one">Płatności</a></nav>';
    const answers: Answers = {
      "POST /login": { body: PANEL(true, nav).replaceAll(HASH, "h-one") },
      "GET /parent/xhr-account": { body: '<body><a href="/parent/invoice/h-one">Faktura</a></body>' },
      "GET /parent/xhr-activity/h-one": { body: "<p>ok</p>" },
    };
    const { deps } = setup(answers);
    const account = (await mondoBillingShapeExport(deps, {})).accounts[0]!;
    expect(account.xhr?.[0]?.skeleton).toContain("/parent/invoice/<id>");
    expect(JSON.stringify(account)).not.toContain("h-one");
  });

  it("masks the hash of every child in the picker, not only the selected one", async () => {
    const other = '<button onclick="window.location.href=\'/auth/set-student/h-other\'"><img src="/parent/photo-children/h-other"><span>Child Two</span></button>';
    const answers: Answers = {
      "POST /login": { body: `${PANEL(true, "<nav></nav>")}${other}` },
      "GET /parent/xhr-account": { body: '<body><a href="/parent/invoice/h-other">Faktura</a></body>' },
      [`GET /parent/xhr-activity/${HASH}`]: { body: "<p>ok</p>" },
    };
    const { deps } = setup(answers);
    const account = (await mondoBillingShapeExport(deps, {})).accounts[0]!;
    expect(account.xhr?.[0]?.skeleton).toContain("/parent/invoice/<id>");
    expect(JSON.stringify(account)).not.toContain("h-other");
  });

  it("writes nothing and gives no accounts without a Mondo Account", async () => {
    const { deps, runtime } = setup(happy(), configOf(activeNowAccount));
    const result = await mondoBillingShapeExport(deps, {});
    expect(result.accounts).toEqual([]);
    expect(runtime.requests).toEqual([]);
    expect(() => (deps.storage as unknown as Record<string, unknown>).appendEvents).toThrow(/storage/);
  });
});

describe("script helpers", () => {
  const mask = { hashes: [HASH], hidden: ["Example Child", "mondo.example.org"] };

  it("keeps a path literal and a short code word, and masks the rest", () => {
    expect(redactLiteral(`/parent/xhr-saldo/${HASH}?id=5`, mask)).toBe('"/parent/xhr-saldo/<id>?id"');
    expect(redactLiteral("saldo_2", mask)).toBe('"saldo_<n>"');
    expect(redactLiteral("Example Child", mask)).toBe('"<text>"');
    expect(redactLiteral("mondo.example.org", mask)).toBe('"<text>"');
    expect(redactLiteral("/x/Example Child/parent@example.org", mask)).toBe('"/x/<hidden>/<email>"');
    expect(redactLiteral("a".repeat(41), mask)).toBe('"<text>"');
  });

  it("makes at most 12 snippets of at most 400 characters", () => {
    const script = Array.from({ length: 30 }, (_, index) => `${"x".repeat(400)} saldo${String.fromCharCode(97 + index)}`).join("\n");
    const snippets = scriptSnippets([script], mask);
    expect(snippets).toHaveLength(12);
    expect(snippets.every((snippet) => snippet.length <= 400)).toBe(true);
  });

  it("makes no snippet without a match and does not repeat overlapping matches", () => {
    expect(scriptSnippets(["var a = 1;"], mask)).toEqual([]);
    expect(scriptSnippets(["xhr-a xhr-b SALDO"], mask)).toHaveLength(1);
  });

  it("masks text after a cut literal start", () => {
    const [snippet] = scriptSnippets([`var t = "Example Child saldo`], mask);
    expect(snippet).toBe('var t = "<text>"');
  });

  it("drops a hash, e-mail or host that the window edge cuts in a comment", () => {
    const secrets = `${HASH} parent@example.org mondo.example.org`;
    const before = scriptSnippets([`// ${secrets} ${"x ".repeat(73)}saldo`], mask);
    const after = scriptSnippets([`saldo ${"y ".repeat(70)}  // ${secrets}`], mask);
    expect(before[0]).toMatch(/^ x x .* saldo$/);
    expect(after[0]).toMatch(/^saldo y y .* \/\/ $/);
    for (const part of [HASH.slice(1), "ent@", ".org", "pare", HASH.slice(0, 3)]) {
      expect([...before, ...after].join("\n")).not.toContain(part);
    }
  });

  it("reads path literals, with a variable or a template placeholder", () => {
    expect(scriptPaths("a('/x/' + id); b('/y/'); c(`/z/${id}`); d('/w'); e('other')")).toEqual([
      { raw: "/x/", placeholder: "variable" },
      { raw: "/y/", placeholder: "bare" },
      { raw: "/z/", placeholder: "variable" },
      { raw: "/w" },
    ]);
  });

  it("does not plan a path twice", () => {
    const panel = { http: undefined as never, origin: ORIGIN, selected: HASH, mask: { hashes: [HASH], hidden: [] } };
    const plan = followPlan([{ raw: "/parent/xhr-a" }, { raw: "/parent/xhr-a" }, { raw: "/parent/xhr-b" }], panel, ["/parent/xhr-b"]);
    expect(plan).toEqual({ fetch: ["/parent/xhr-a"], skipped: [] });
  });
});

describe("navEntries", () => {
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

  it("masks the hash even when it has no digit", () => {
    expect(maskPath("/parent/xhr-activity/abcdefghijkl?x=1", "abcdefghijkl")).toBe("/parent/xhr-activity/<id>?x");
  });
});
