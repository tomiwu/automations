import { fakeRuntime } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { createEduskySource } from "./edusky-source.ts";
import { activityTargets } from "./targets.ts";
import { SECRETS, testConfig } from "./test-fixtures.ts";

const ORIGIN = "https://organizer.edusky.example.org";

const baseConfig = JSON.stringify({ OAuth2: { clientId: "cid", accessTokenUri: `${ORIGIN}/core/web/oauth/v2/token` } });
const item = (day: string, courseGroup: string, extra: Record<string, unknown> = {}) => ({
  start: `${day}T16:00`,
  end: `${day}T16:45`,
  courseGroup,
  titleRoom: "Room 5",
  cancel: 0,
  idActivityShifted: null,
  dateBeforeShifted: "",
  ...extra,
});

type Answer = { status?: number; body: string };

const calendarItems = [
  item("2026-10-21", "Group Blue / Example School"),
  item("2026-10-20", "Group Red / Example School"),
  item("2026-10-26", "Group Blue / Example School", { cancel: 1 }),
  item("2026-11-30", "Group Blue / Example School"),
];

const happy: Record<string, Answer> = {
  [`GET ${ORIGIN}/core/web/external/baseconfig`]: { body: baseConfig },
  [`POST ${ORIGIN}/core/web/oauth/v2/token`]: { body: JSON.stringify({ access_token: "tok" }) },
  [`GET ${ORIGIN}/core/web/api/common/users/auth`]: { body: JSON.stringify({ id_userdata: 7 }) },
  [`GET ${ORIGIN}/core/web/api/ext/calendaritemslist`]: { body: JSON.stringify(calendarItems) },
};

function setup(answers: Record<string, Answer>, secrets: Record<string, string> = SECRETS) {
  const runtime = fakeRuntime({
    secrets,
    now: new Date("2026-10-20T08:00:00Z"),
    respond: (input, init) => {
      const url = new URL(input);
      const answer = answers[`${init?.method ?? "GET"} ${url.origin}${url.pathname}`] ?? { status: 404, body: "missing" };
      return new Response(answer.body, { status: answer.status ?? 200 });
    },
  });
  const target = activityTargets(testConfig()).targets[1]!;
  return { runtime, source: createEduskySource(runtime, target, "UTC") };
}

describe("createEduskySource", () => {
  it("gives the Sessions of the group of the Account in the 14-day window, ordered by start", async () => {
    const { source } = setup(happy);
    const sessions = await source.sessions();
    expect(sessions.map((s) => [s.start, s.activity, s.status, s.place])).toEqual([
      ["2026-10-21T16:00", "Dance", "planned", "Room 5"],
      ["2026-10-26T16:00", "Dance", "cancelled", "Room 5"],
    ]);
  });

  it("logs in with the secret values and reads the calendar of the window", async () => {
    const { source, runtime } = setup(happy);
    await source.sessions();
    const login = runtime.requests.find((r) => r.init?.method === "POST");
    expect(login?.init?.body).toBe(
      "grant_type=password&client_id=cid&client_secret=client-secret&username=login-two&password=password%26two",
    );
    const list = runtime.requests.find((r) => r.input.includes("calendaritemslist"));
    expect(list?.input).toBe(`${ORIGIN}/core/web/api/ext/calendaritemslist?idParent=7&dateFrom=2026-10-20&dateTo=2026-11-03`);
    expect(new Headers(list?.init?.headers).get("authorization")).toBe("Bearer tok");
  });

  it("rejects a login that the organizer rejects", async () => {
    const { source } = setup({ ...happy, [`POST ${ORIGIN}/core/web/oauth/v2/token`]: { status: 400, body: '{"error":"invalid_request"}' } });
    await expect(source.sessions()).rejects.toThrow(/login rejected/);
  });

  it("rejects a login answer that is not JSON", async () => {
    const { source } = setup({ ...happy, [`POST ${ORIGIN}/core/web/oauth/v2/token`]: { body: "<html>" } });
    await expect(source.sessions()).rejects.toThrow(/login rejected/);
  });

  it("reports a page that fails with its status", async () => {
    const { source } = setup({ ...happy, [`GET ${ORIGIN}/core/web/api/ext/calendaritemslist`]: { status: 500, body: "" } });
    await expect(source.sessions()).rejects.toThrow(/calendar: not available \(HTTP 500\)/);
  });

  it("reports an answer that is not JSON as a changed site", async () => {
    const { source } = setup({ ...happy, [`GET ${ORIGIN}/core/web/api/common/users/auth`]: { body: "<html>" } });
    await expect(source.sessions()).rejects.toThrow(/user: not JSON/);
  });

  it("rejects when the client secret is not set", async () => {
    const { EDUSKY_CLIENT_SECRET: _unused, ...secrets } = SECRETS;
    const { source } = setup(happy, secrets);
    await expect(source.sessions()).rejects.toThrow(/EDUSKY_CLIENT_SECRET/);
  });
});
