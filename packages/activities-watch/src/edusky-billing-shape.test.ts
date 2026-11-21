import { countFetches, fakeRuntime } from "@automations/shared";
import type { Account, Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { eduskyBillingShapeExport } from "./edusky-billing-shape.ts";
import { FAMILY_ID, SECRETS, eduskyAccount, readOnlyStorage, testConfig } from "./test-fixtures.ts";

const ORIGIN = "https://organizer.edusky.example.org";
const OTHER_ORIGIN = "https://other.edusky.example.org";
const API = "/core/web/api/";

const baseConfig = (origin: string) =>
  JSON.stringify({ OAuth2: { clientId: "cid", accessTokenUri: `${origin}/core/web/oauth/v2/token` } });
const CLOUDFLARE = "<html><title>Just a moment...</title></html>";

type Answer = { status?: number; body: string };
type Answers = Record<string, Answer>;

const json = (value: unknown, status = 200): Answer => ({ status, body: JSON.stringify(value) });

const AGREEMENT = {
  id: 90210,
  dateFrom: "2025-09-01",
  parent: { name: "Example Parent", email: "parent@example.org" },
  paymentPlan: [{ dateTo: "2025-10-10", paymentMissingValue: 120.5, status: 1 }],
  paymentsMade: [{ paymentDate: "2025-10-02", amount: "120,50 zł" }],
};
const BALANCE = { documents: [], balance: { paymentsSum: 360, paymentsDueSum: 120, invoicesBalance: -4.2, periods: "Example text" } };

function answersFor(origin: string, auth: unknown, extra: Answers = {}): Answers {
  return {
    [`GET ${origin}/core/web/external/baseconfig`]: { body: baseConfig(origin) },
    [`GET ${origin}/core/web/oauth/v2/token`]: json({ access_token: "tok" }),
    [`GET ${origin}${API}common/users/auth`]: json(auth),
    [`GET ${origin}${API}agreements`]: json({ data: [{ id: 90210 }, { id: 90211 }], total: 2 }),
    [`GET ${origin}${API}ext/agreements/90210`]: json(AGREEMENT),
    [`GET ${origin}${API}ext/agreementinvoicesbalance`]: json(BALANCE),
    ...extra,
  };
}

const AUTH_PLAIN = { id_userdata: 7, email: "parent@example.org", name: "Example Parent" };

function eduskyAccount2(overrides: Partial<Account>): Account {
  return { ...eduskyAccount, id: "00000000-0000-4000-8000-0000000000a9", ...overrides };
}

function configWith(...extra: Account[]): Config {
  const base = testConfig();
  return { ...base, accounts: [...base.accounts, ...extra] };
}

function setup(answers: Answers, config: Config = testConfig()) {
  const runtime = fakeRuntime({
    secrets: SECRETS,
    now: new Date("2026-10-20T08:00:00Z"),
    respond: (input, init) => {
      const url = new URL(input);
      const answer = answers[`${init?.method ?? "GET"} ${url.origin}${url.pathname}`] ?? { status: 404, body: "missing" };
      return new Response(answer.body, { status: answer.status ?? 200 });
    },
  });
  const counter = countFetches(runtime.fetch);
  const deps = {
    runtime: { ...runtime, fetch: counter.fetch },
    storage: readOnlyStorage(config),
    familyId: FAMILY_ID,
    counter,
  };
  return { runtime, deps };
}

const paths = (runtime: { requests: { input: string }[] }): string[] =>
  runtime.requests.map((request) => new URL(request.input).pathname.replace("/core/web", ""));

describe("eduskyBillingShapeExport", () => {
  it("rejects unknown input keys", async () => {
    const { deps } = setup(answersFor(ORIGIN, AUTH_PLAIN));
    await expect(eduskyBillingShapeExport(deps, { extra: 1 })).rejects.toThrow(/Unknown input key/);
  });

  it("sends 6 requests when users/auth has no agreements, and reads the first agreement only", async () => {
    const { deps, runtime } = setup(answersFor(ORIGIN, AUTH_PLAIN));
    const result = await eduskyBillingShapeExport(deps, {});
    expect(paths(runtime)).toEqual([
      "/external/baseconfig",
      "/oauth/v2/token",
      `/api/common/users/auth`,
      "/api/agreements",
      "/api/ext/agreements/90210",
      "/api/ext/agreementinvoicesbalance",
    ]);
    expect(runtime.requests[3]?.input).toContain("page=1&perPage=20");
    expect(runtime.requests[5]?.input).toContain("idAgreement=90210");
    const account = result.accounts[0]!;
    expect(account).toMatchObject({
      account: "account 1",
      authStatus: 200,
      listSource: "list",
      listStatus: 200,
      agreementCount: 2,
      agreementStatus: 200,
      balanceStatus: 200,
    });
    expect(JSON.parse(account.agreementShape!).paymentPlan).toEqual({
      $length: 1,
      $item: { dateTo: "<date>", paymentMissingValue: "<number>", status: 1 },
    });
    expect(JSON.parse(account.balanceShape!).balance.paymentsDueSum).toBe("<number>");
    expect(result.fetches?.total).toBe(6);
  });

  it("sends 5 requests when users/auth has the agreements", async () => {
    const auth = { ...AUTH_PLAIN, userAgreements: [{ id: 90210 }] };
    const { deps, runtime } = setup(answersFor(ORIGIN, auth));
    const result = await eduskyBillingShapeExport(deps, {});
    expect(paths(runtime)).toHaveLength(5);
    expect(paths(runtime)).not.toContain("/api/agreements");
    expect(result.accounts[0]).toMatchObject({ listSource: "auth", agreementCount: 1, agreementStatus: 200 });
    expect(result.accounts[0]?.listStatus).toBeUndefined();
  });

  it("finds the ids in a top-level array and in items or rows", async () => {
    for (const list of [[{ id: 1 }], { items: [{ id: 1 }] }, { rows: [{ id: 1 }] }]) {
      const { deps } = setup(answersFor(ORIGIN, AUTH_PLAIN, { [`GET ${ORIGIN}${API}agreements`]: json(list) }));
      const result = await eduskyBillingShapeExport(deps, {});
      expect(result.accounts[0]?.agreementCount).toBe(1);
    }
  });

  it("records a 403 JSON on the list and skips the agreement and balance", async () => {
    const answers = answersFor(ORIGIN, AUTH_PLAIN, { [`GET ${ORIGIN}${API}agreements`]: json({ message: "Forbidden" }, 403) });
    const { deps, runtime } = setup(answers);
    const result = await eduskyBillingShapeExport(deps, {});
    expect(paths(runtime)).toHaveLength(4);
    expect(result.accounts[0]).toMatchObject({ listStatus: 403, listShape: '{"message":"<text>"}', agreementCount: 0 });
    expect(result.accounts[0]?.agreementStatus).toBeUndefined();
  });

  it("records a missing agreement and still reads the balance", async () => {
    const answers = answersFor(ORIGIN, AUTH_PLAIN, { [`GET ${ORIGIN}${API}ext/agreements/90210`]: { status: 404, body: "gone" } });
    const { deps } = setup(answers);
    const result = await eduskyBillingShapeExport(deps, {});
    expect(result.accounts[0]).toMatchObject({ agreementStatus: 404, balanceStatus: 200 });
    expect(result.accounts[0]?.agreementShape).toBeUndefined();
  });

  it("counts no agreement when the list has no ids", async () => {
    const answers = answersFor(ORIGIN, AUTH_PLAIN, { [`GET ${ORIGIN}${API}agreements`]: { body: "not json" } });
    const { deps, runtime } = setup(answers);
    const result = await eduskyBillingShapeExport(deps, {});
    expect(paths(runtime)).toHaveLength(4);
    expect(result.accounts[0]).toMatchObject({ listStatus: 200, agreementCount: 0 });
  });

  it("stops the whole probe on a Cloudflare challenge", async () => {
    const second = eduskyAccount2({ origin: OTHER_ORIGIN, login_secret: "CHILD2_EDUSKY_LOGIN" });
    const answers = answersFor(ORIGIN, AUTH_PLAIN, { [`GET ${ORIGIN}${API}agreements`]: { status: 403, body: CLOUDFLARE } });
    const { deps, runtime } = setup({ ...answers, ...answersFor(OTHER_ORIGIN, AUTH_PLAIN) }, configWith(second));
    const result = await eduskyBillingShapeExport(deps, {});
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.status).toContain("Cloudflare");
    expect(runtime.requests.some((request) => request.input.startsWith(OTHER_ORIGIN))).toBe(false);
  });

  it("stops the whole probe when the login is blocked", async () => {
    const second = eduskyAccount2({ origin: OTHER_ORIGIN });
    const answers = answersFor(ORIGIN, AUTH_PLAIN, { [`GET ${ORIGIN}/core/web/oauth/v2/token`]: { status: 403, body: CLOUDFLARE } });
    const { deps } = setup(answers, configWith(second));
    const result = await eduskyBillingShapeExport(deps, {});
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0]?.status).toContain("<hidden>");
    expect(JSON.stringify(result.accounts)).not.toContain("edusky.example.org");
  });

  it("goes on with the next Account after another error", async () => {
    const second = eduskyAccount2({ origin: OTHER_ORIGIN });
    const answers = { ...answersFor(OTHER_ORIGIN, AUTH_PLAIN) };
    const { deps } = setup(answers, configWith(second));
    const result = await eduskyBillingShapeExport(deps, {});
    expect(result.accounts.map((a) => a.account)).toEqual(["account 1", "account 2"]);
    expect(result.accounts[0]?.status).toMatch(/not available \(HTTP 404\)/);
    expect(result.accounts[1]?.agreementCount).toBe(2);
  });

  it("runs one probe for two Accounts with the same origin and login", async () => {
    const twin = eduskyAccount2({ group: "Group Red" });
    const { deps, runtime } = setup(answersFor(ORIGIN, AUTH_PLAIN), configWith(twin));
    const result = await eduskyBillingShapeExport(deps, {});
    expect(result.accounts).toEqual([expect.objectContaining({ account: "account 1" }), { account: "account 2", sameAs: "account 1" }]);
    expect(paths(runtime)).toHaveLength(6);
  });

  it("has no id, name, e-mail, amount or date in the result", async () => {
    const { deps } = setup(answersFor(ORIGIN, { ...AUTH_PLAIN, userAgreements: [{ id: 90210 }] }));
    const text = JSON.stringify((await eduskyBillingShapeExport(deps, {})).accounts);
    for (const fake of ["90210", "90211", "Example Parent", "parent@example.org", "120,50", "2025-10", "organizer.edusky", "tok", "client-secret"]) {
      expect(text).not.toContain(fake);
    }
  });

  it("writes nothing", async () => {
    const { deps } = setup(answersFor(ORIGIN, AUTH_PLAIN));
    await expect(eduskyBillingShapeExport(deps, {})).resolves.toBeDefined();
    expect(() => (deps.storage as unknown as Record<string, unknown>).appendEvents).toThrow(/storage/);
  });
});
