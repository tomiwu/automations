import { fakeRuntime } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { createActiveNowSource } from "./activenow-source.ts";
import { activityTargets } from "./targets.ts";
import { SECRETS, card, month, testConfig } from "./test-fixtures.ts";

const LOGIN_FORM =
  '<form action="/users/sign_in"><input type="hidden" name="authenticity_token" value="tok+/=" /><input name="user[email]" /><input type="password" name="user[password]" /></form>';
const PICKER =
  '<meta name="csrf-token" content="csrf1"><a href="/role_selector/change_role?school_user_id=1&amp;user_equivalent_id=2"><p>Child Zero</p></a><a href="/role_selector/change_role?school_user_id=1&amp;user_equivalent_id=3"><p>Child One</p></a>';
const LESSONS =
  month(
    "2026-10",
    card({ date: "20 października, wtorek" }),
    card({ date: "27 października, wtorek" }),
    card({ date: "6 października, wtorek" }),
  ) + month("2026-12", card({ date: "1 grudnia, wtorek" }));

type Answer = { status?: number; location?: string; body?: string; cookie?: string };

const happy: Record<string, Answer> = {
  "GET /users/sign_in": { body: LOGIN_FORM, cookie: "pre=1" },
  "POST /users/sign_in": { status: 302, location: "/role_selector/choose_user_role", cookie: "sess=abc" },
  "GET /role_selector/choose_user_role": { body: PICKER },
  "POST /role_selector/change_role": { status: 302, location: "/client_panel/upcoming_classes" },
  "GET /client_panel/upcoming_classes": { body: "panel" },
  "GET /client_panel/all_events/events": { body: LESSONS },
};

function setup(answers: Record<string, Answer>) {
  const runtime = fakeRuntime({
    secrets: SECRETS,
    now: new Date("2026-10-20T08:00:00Z"),
    respond: (input, init) => {
      const answer = answers[`${init?.method ?? "GET"} ${new URL(input).pathname}`] ?? { status: 404, body: "missing" };
      const headers = new Headers();
      if (answer.location) headers.set("location", answer.location);
      if (answer.cookie) headers.append("set-cookie", `${answer.cookie}; path=/; HttpOnly`);
      return new Response(answer.body ?? "", { status: answer.status ?? 200, headers });
    },
  });
  const target = activityTargets(testConfig()).targets[0]!;
  return { runtime, source: createActiveNowSource(runtime, target, "UTC") };
}

const headerOf = (init: RequestInit | undefined, name: string): string | null => new Headers(init?.headers).get(name);

describe("createActiveNowSource", () => {
  it("logs in with the secret values, opens the profile and gives the Sessions of the 14-day window", async () => {
    const { source, runtime } = setup(happy);
    const sessions = await source.sessions();
    expect(sessions.map((s) => [s.start, s.activity, s.place, s.status])).toEqual([
      ["2026-10-20T15:00", "Choir", "Example Hall", "planned"],
      ["2026-10-27T15:00", "Choir", "Example Hall", "planned"],
    ]);
    const login = runtime.requests.find((r) => r.init?.method === "POST" && r.input.endsWith("/users/sign_in"));
    expect(login?.init?.body).toBe(
      "authenticity_token=tok%2B%2F%3D&user%5Bemail%5D=login-one&user%5Bpassword%5D=password+one",
    );
    const role = runtime.requests.find((r) => r.input.includes("change_role"));
    expect(role?.input).toMatch(/user_equivalent_id=3$/);
    expect(headerOf(role?.init, "x-csrf-token")).toBe("csrf1");
  });

  it("sends the cookies of the login with the later requests", async () => {
    const { source, runtime } = setup(happy);
    await source.sessions();
    expect(headerOf(runtime.requests.at(-1)?.init, "cookie")).toMatch(/sess=abc/);
  });

  it("rejects a login that comes back to the form", async () => {
    const { source } = setup({ ...happy, "POST /users/sign_in": { body: LOGIN_FORM } });
    await expect(source.sessions()).rejects.toThrow(/login rejected/);
  });

  it("reports a login page without a token as a changed site", async () => {
    const { source } = setup({ ...happy, "GET /users/sign_in": { body: "<html></html>" } });
    await expect(source.sessions()).rejects.toThrow(/login form not found/);
  });

  it("reports a login that has no profile of the Child", async () => {
    const { source } = setup({ ...happy, "GET /role_selector/choose_user_role": { body: PICKER.replace("Child One", "Other") } });
    await expect(source.sessions()).rejects.toThrow(/profile of the Child not found/);
  });

  it("goes straight to the lessons when the login has one Child", async () => {
    const { source, runtime } = setup({ ...happy, "POST /users/sign_in": { status: 302, location: "/client_panel/upcoming_classes" } });
    expect(await source.sessions()).toHaveLength(2);
    expect(runtime.requests.some((r) => r.input.includes("change_role"))).toBe(false);
  });

  it("reports a lessons page that fails with its status", async () => {
    const { source } = setup({ ...happy, "GET /client_panel/all_events/events": { status: 500 } });
    await expect(source.sessions()).rejects.toThrow(/HTTP 500/);
  });

  it("stops a redirect loop", async () => {
    const { source } = setup({ ...happy, "GET /users/sign_in": { status: 302, location: "/users/sign_in" } });
    await expect(source.sessions()).rejects.toThrow(/Too many redirects/);
  });

  it("rejects when a secret is missing", async () => {
    const runtime = fakeRuntime({ secrets: {} });
    const target = activityTargets(testConfig()).targets[0]!;
    await expect(createActiveNowSource(runtime, target, "UTC").sessions()).rejects.toThrow(/CHILD1_ACTIVENOW_LOGIN/);
  });

  it("rejects an Account without an Activity", async () => {
    const { runtime } = setup(happy);
    const target = { ...activityTargets(testConfig()).targets[0]!, activities: [] };
    await expect(createActiveNowSource(runtime, target, "UTC").sessions()).rejects.toThrow(/no enabled Activity/);
  });
});
