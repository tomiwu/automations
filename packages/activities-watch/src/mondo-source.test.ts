import { readFileSync } from "node:fs";
import { fakeRuntime } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { createMondoSource } from "./mondo-source.ts";
import { createSource } from "./source.ts";
import { activityTargets, type ActivityTarget } from "./targets.ts";
import { ACTIVITY1, CHILD1, activeNowAccount, choirActivity, testConfig } from "./test-fixtures.ts";

const MONDO_ACCOUNT = "00000000-0000-4000-8000-0000000000a3";
const SECRETS = { CHILD1_MONDO_LOGIN: "child@example.org", CHILD1_MONDO_PASSWORD: "pass&word" };

const PANEL = readFileSync(new URL("./fixtures/mondo-activity.html", import.meta.url), "utf8");
const picker = (selected: boolean): string =>
  `<button ${selected ? "" : `onclick="window.location.href='/auth/set-student/h-one'"`}><img src="/parent/photo-children/h-one?r=1"><span>Child One</span></button>` +
  `<button onclick="window.location.href='/auth/set-student/h-two'"><img src="/parent/photo-children/h-two"><span>Child Two</span></button>`;

type Answer = { status?: number; body?: string };

const happy: Record<string, Answer> = {
  "POST /login": { body: picker(true) },
  "GET /parent/xhr-activity/h-one": { body: PANEL },
};

function targetOf(group: string | null = "Child One"): ActivityTarget {
  const config = testConfig();
  config.accounts = [
    {
      ...activeNowAccount,
      id: MONDO_ACCOUNT,
      service: "mondo",
      origin: "https://mondo.example.org",
      group,
      login_secret: "CHILD1_MONDO_LOGIN",
      password_secret: "CHILD1_MONDO_PASSWORD",
    },
  ];
  config.activities = [{ ...choirActivity, account_id: MONDO_ACCOUNT }];
  return activityTargets(config).targets[0]!;
}

function setup(answers: Record<string, Answer>, target = targetOf()) {
  const runtime = fakeRuntime({
    secrets: SECRETS,
    now: new Date("2026-10-20T08:00:00Z"),
    respond: (input, init) => {
      const answer = answers[`${init?.method ?? "GET"} ${new URL(input).pathname}`] ?? { status: 404, body: "missing" };
      return new Response(answer.body ?? "", { status: answer.status ?? 200 });
    },
  });
  return { runtime, source: createMondoSource(runtime, target, "UTC") };
}

describe("createMondoSource", () => {
  it("logs in with the secret values and gives the Sessions of the 14-day window", async () => {
    const { source, runtime } = setup(happy);
    const sessions = await source.sessions();
    expect(sessions.map((s) => [s.start, s.end, s.activity, s.service, s.place, s.status, s.id])).toEqual([
      ["2026-10-26T13:00", "2026-10-26T13:30", "Choir", "mondo", "Example Hall MON 13:00-13:30", "planned", `${ACTIVITY1}:2026-10-26:13:00`],
      ["2026-11-02T13:00", "2026-11-02T13:30", "Choir", "mondo", "Example Hall MON 13:00-13:30", "cancelled", `${ACTIVITY1}:2026-11-02:13:00`],
    ]);
    expect(sessions[0]?.childId).toBe(CHILD1);
    expect(runtime.requests[0]?.input).toBe("https://mondo.example.org/login");
    expect(runtime.requests[0]?.init?.body).toBe("login%5Bemail%5D=child%40example.org&login%5Bpassword%5D=pass%26word");
  });

  it("selects the child first when the picker shows another child", async () => {
    const { source, runtime } = setup({ ...happy, "POST /login": { body: picker(false) }, "GET /auth/set-student/h-one": {} });
    expect(await source.sessions()).toHaveLength(2);
    expect(runtime.requests.map((r) => new URL(r.input).pathname)).toEqual([
      "/login",
      "/auth/set-student/h-one",
      "/parent/xhr-activity/h-one",
    ]);
  });

  it("uses the name of the Child when the Account has no group", async () => {
    const { source } = setup(happy, targetOf(null));
    expect(await source.sessions()).toHaveLength(2);
  });

  it("reports a child that is not in the picker", async () => {
    const { source } = setup({ "POST /login": { body: "<button>Other</button>" } });
    await expect(source.sessions()).rejects.toThrow(/Mondo: child Child One not found/);
  });

  it("reports a class list that fails", async () => {
    const { source } = setup({ "POST /login": { body: picker(true) } });
    await expect(source.sessions()).rejects.toThrow(/class list failed \(HTTP 404\)/);
  });

  it("reports a rejected login", async () => {
    const { source } = setup({ "POST /login": { status: 401, body: "no" } });
    await expect(source.sessions()).rejects.toThrow(/login rejected \(HTTP 401/);
  });

  it("treats the login form shown again as a rejected login", async () => {
    const { source } = setup({ "POST /login": { body: '<form><input name="login[password]"></form>' } });
    await expect(source.sessions()).rejects.toThrow(/login rejected \(HTTP 200/);
  });

  it("reports a page without a class list as a changed site", async () => {
    const { source } = setup({ ...happy, "GET /parent/xhr-activity/h-one": { body: "<p>Hello</p>" } });
    await expect(source.sessions()).rejects.toThrow(/class list not found/);
  });

  it("rejects an Account without an Activity before any request", async () => {
    const { source, runtime } = setup(happy, { ...targetOf(), activities: [] });
    await expect(source.sessions()).rejects.toThrow(/no enabled Activity/);
    expect(runtime.requests).toEqual([]);
  });

  it("is the source that createSource gives for a Mondo Account", async () => {
    const { runtime } = setup(happy);
    expect(await createSource(runtime)(targetOf(), "UTC").sessions()).toHaveLength(2);
  });
});
