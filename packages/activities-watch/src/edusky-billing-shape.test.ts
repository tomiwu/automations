import { countFetches, fakeRuntime } from "@automations/shared";
import type { Account, Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { eduskyBillingShapeExport, financeFlags, flagValue, rolesOf } from "./edusky-billing-shape.ts";
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

function answersFor(origin: string, auth: unknown, extra: Answers = {}): Answers {
  return {
    [`GET ${origin}/core/web/external/baseconfig`]: { body: baseConfig(origin) },
    [`GET ${origin}/core/web/oauth/v2/token`]: json({ access_token: "tok" }),
    [`GET ${origin}${API}common/users/auth`]: json(auth),
    ...extra,
  };
}

const AUTH_PLAIN = {
  id_userdata: 7,
  email: "parent@example.org",
  name: "Example Parent",
  roles: ["ROLE_PARENT", "ROLE_secret.name@example.org"],
  financeDisable: "0",
  blockSettlementView: 1,
  blockSettlementInfo: true,
};

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

  it("sends 3 requests per Account and no list request", async () => {
    const { deps, runtime } = setup(answersFor(ORIGIN, AUTH_PLAIN));
    const result = await eduskyBillingShapeExport(deps, {});
    expect(paths(runtime)).toEqual(["/external/baseconfig", "/oauth/v2/token", "/api/common/users/auth"]);
    expect(result.accounts[0]).toMatchObject({ account: "account 1", authStatus: 200 });
    expect(result.fetches?.total).toBe(3);
  });

  it("returns the flags and the roles", async () => {
    const { deps } = setup(answersFor(ORIGIN, AUTH_PLAIN));
    const account = (await eduskyBillingShapeExport(deps, {})).accounts[0]!;
    expect(account.flags).toEqual({ financeDisable: 0, blockSettlementView: 1, blockSettlementInfo: 1 });
    expect(account.roles).toEqual(["ROLE_PARENT", "<text>"]);
    expect(JSON.parse(account.authShape!).roles.$length).toBe(2);
  });

  it("maps a missing flag to null and an unknown value to <other>", async () => {
    const auth = { roles: [], financeDisable: "x", blockSettlementView: null };
    const { deps } = setup(answersFor(ORIGIN, auth));
    const account = (await eduskyBillingShapeExport(deps, {})).accounts[0]!;
    expect(account.flags).toEqual({ financeDisable: "<other>", blockSettlementView: "<other>", blockSettlementInfo: null });
    expect(account.roles).toEqual([]);
  });

  it("keeps a non-JSON auth answer without flags values", async () => {
    const answers = answersFor(ORIGIN, AUTH_PLAIN, { [`GET ${ORIGIN}${API}common/users/auth`]: { status: 500, body: "oops" } });
    const { deps } = setup(answers);
    const account = (await eduskyBillingShapeExport(deps, {})).accounts[0]!;
    expect(account).toMatchObject({ authStatus: 500, roles: [] });
    expect(account.flags).toEqual({ financeDisable: null, blockSettlementView: null, blockSettlementInfo: null });
  });

  it("stops the whole probe on a Cloudflare challenge", async () => {
    const second = eduskyAccount2({ origin: OTHER_ORIGIN, login_secret: "CHILD2_EDUSKY_LOGIN" });
    const answers = answersFor(ORIGIN, AUTH_PLAIN, { [`GET ${ORIGIN}${API}common/users/auth`]: { status: 403, body: CLOUDFLARE } });
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
    expect(result.accounts[1]).toMatchObject({ authStatus: 200 });
  });

  it("runs one probe for two Accounts with the same origin and login", async () => {
    const twin = eduskyAccount2({ group: "Group Red" });
    const { deps, runtime } = setup(answersFor(ORIGIN, AUTH_PLAIN), configWith(twin));
    const result = await eduskyBillingShapeExport(deps, {});
    expect(result.accounts).toEqual([expect.objectContaining({ account: "account 1" }), { account: "account 2", sameAs: "account 1" }]);
    expect(paths(runtime)).toHaveLength(3);
  });

  it("has no id, name, e-mail, amount or date in the result", async () => {
    const { deps } = setup(answersFor(ORIGIN, AUTH_PLAIN));
    const text = JSON.stringify((await eduskyBillingShapeExport(deps, {})).accounts);
    for (const fake of ["Example Parent", "parent@example.org", "secret.name", "organizer.edusky", "tok", "client-secret"]) {
      expect(text).not.toContain(fake);
    }
  });

  it("writes nothing", async () => {
    const { deps } = setup(answersFor(ORIGIN, AUTH_PLAIN));
    await expect(eduskyBillingShapeExport(deps, {})).resolves.toBeDefined();
    expect(() => (deps.storage as unknown as Record<string, unknown>).appendEvents).toThrow(/storage/);
  });
});

describe("flagValue, financeFlags and rolesOf", () => {
  it("maps the accepted values", () => {
    expect(["0", 1, true, false, "1", 0, undefined, "x", 2, null].map(flagValue)).toEqual([0, 1, 1, 0, 1, 0, null, "<other>", "<other>", "<other>"]);
  });

  it("gives null flags and no roles for a value that is not an object", () => {
    expect(financeFlags("text")).toEqual({ financeDisable: null, blockSettlementView: null, blockSettlementInfo: null });
    expect(rolesOf(undefined)).toEqual([]);
    expect(rolesOf({ roles: "ROLE_PARENT" })).toEqual([]);
  });

  it("masks a role that does not match the pattern", () => {
    expect(rolesOf({ roles: ["ROLE_PARENT", "role_x", 5, "ROLE_" + "A".repeat(41)] })).toEqual(["ROLE_PARENT", "<text>", "<text>", "<text>"]);
  });
});
