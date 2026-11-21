import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "kody-publish.mjs");
const FAKE_TOKEN = "kody_at_FAKE-token-for-tests";
const PKG = "@example/pkg";

type Answer = { status: number; body: unknown };
interface Script {
  publish: Answer[];
  runs?: Answer[];
}

let server: Server | undefined;
afterEach(() => server?.close());

const ok = (body: unknown): Answer => ({ status: 200, body });
const dispatched = ok({ status: "dispatched", workflow_id: "dynwf-1", message: "dispatched" });
const published = { status: "published", published_commit: "c0ffee1", previous_commit: "beef000" };
const alreadyPublished = { status: "already_published", published_commit: "c0ffee1" };
const running = ok({ status: "running", result: null, last_error: null });
const complete = (result: unknown) => ok({ status: "complete", result, last_error: null });
const errored = (last_error: string | null) => ok({ status: "errored", result: null, last_error });

/** A fake Kody Open API. Each list gives the answers in order; the last answer repeats. */
async function fakeKody(plan: Script) {
  const seen: string[] = [];
  const counts = { publish: 0, runs: 0 };
  const next = (list: Answer[], key: "publish" | "runs") => list[Math.min(counts[key]++, list.length - 1)]!;
  server = createServer((req, res) => {
    const auth = req.headers.authorization === `Bearer ${FAKE_TOKEN}`;
    seen.push(`${req.method} ${req.url}${auth ? "" : " NO-AUTH"}`);
    let answer: Answer = { status: 404, body: {} };
    if (req.url === "/v1/packages") answer = ok({ packages: [{ package_id: "pkg-1", name: PKG }, { package_id: "x", name: "@other/x" }] });
    else if (req.url === "/v1/packages/pkg-1/external-push" && req.method === "POST") answer = next(plan.publish, "publish");
    else if (req.url === "/v1/packages/runs/dynwf-1" && req.method === "GET") answer = next(plan.runs ?? [running], "runs");
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { seen, url: `http://127.0.0.1:${port}` };
}

function publish(url: string, env: Record<string, string> = {}, pkg = PKG) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn("node", [script, pkg], {
      env: { PATH: process.env.PATH ?? "", KODY_API_TOKEN: FAKE_TOKEN, KODY_API_URL: url, KODY_PUBLISH_POLL_MS: "20", KODY_PUBLISH_WAIT_MS: "5000", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const posts = (seen: string[]) => seen.filter((s) => s.startsWith("POST")).length;
const runReads = (seen: string[]) => seen.filter((s) => s.startsWith("GET /v1/packages/runs/")).length;

describe("kody-publish.mjs", () => {
  it("returns at once when Kody answers already_published", async () => {
    const { seen, url } = await fakeKody({ publish: [ok(alreadyPublished)] });
    const r = await publish(url);
    expect(r.code).toBe(0);
    expect(seen).toEqual(["GET /v1/packages", "POST /v1/packages/pkg-1/external-push"]);
    expect(r.out).toContain("done: already_published c0ffee1");
  });

  it("follows dispatched -> running -> complete with published, with one POST", async () => {
    const { seen, url } = await fakeKody({ publish: [dispatched], runs: [running, running, complete(published)] });
    const r = await publish(url);
    expect(r.code).toBe(0);
    expect(runReads(seen)).toBe(3);
    expect(posts(seen)).toBe(1);
    expect(seen.some((s) => s.includes("workflow-runs"))).toBe(false);
    expect(r.out).toContain("status=running");
    expect(r.out).toContain("done: published c0ffee1");
  });

  it("gives exit 0 when the run result is already_published", async () => {
    const { url } = await fakeKody({ publish: [dispatched], runs: [complete(alreadyPublished)] });
    const r = await publish(url);
    expect(r.code).toBe(0);
    expect(r.out).toContain("done: already_published");
  });

  it("fails when the run ends errored with last_error (a refusal)", async () => {
    const { seen, url } = await fakeKody({ publish: [dispatched], runs: [running, errored("checks_failed: typecheck")] });
    const r = await publish(url);
    expect(r.code).toBe(1);
    expect(r.out).toContain("last_error: checks_failed: typecheck");
    expect(r.out).toContain("ended with status=errored");
    expect(seen.some((s) => s.includes("workflow-runs"))).toBe(false);
  });

  it.each(["terminated", "cancelled"])("fails when the run ends %s without a result", async (status) => {
    const { url } = await fakeKody({ publish: [dispatched], runs: [ok({ status, result: null, last_error: null })] });
    const r = await publish(url);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`status=${status}`);
  });

  it("fails when the run result is a refusal status", async () => {
    const { url } = await fakeKody({ publish: [dispatched], runs: [complete({ status: "not_fast_forward", message: "remote moved" })] });
    const r = await publish(url);
    expect(r.code).toBe(1);
    expect(r.out).toContain("status=not_fast_forward");
  });

  it("fails on a refusal in the publish answer and on a missing workflow_id", async () => {
    const refused = await fakeKody({ publish: [ok({ status: "checks_failed", message: "typecheck" })] });
    const r1 = await publish(refused.url);
    expect(r1.code).toBe(1);
    expect(r1.out).toContain("status=checks_failed");
    server?.close();
    const lost = await fakeKody({ publish: [ok({ status: "dispatched" })] });
    expect((await publish(lost.url)).code).toBe(1);
  });

  it("fails when the wait limit is reached", async () => {
    const { url } = await fakeKody({ publish: [dispatched], runs: [running] });
    const r = await publish(url, { KODY_PUBLISH_WAIT_MS: "200" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("not done within");
  });

  it("tries again on 503 for publish and for the run read, and never prints the token", async () => {
    const { seen, url } = await fakeKody({ publish: [{ status: 503, body: { error: FAKE_TOKEN } }, dispatched], runs: [{ status: 503, body: {} }, complete(published)] });
    const r = await publish(url);
    expect(r.code).toBe(0);
    expect(posts(seen)).toBe(2);
    expect(r.out).toContain("no answer (HTTP 503)");
    expect(r.out).not.toContain(FAKE_TOKEN);
  });

  it("fails at once on 401, on a 4xx run read, and when the package is unknown", async () => {
    const denied = await fakeKody({ publish: [{ status: 401, body: { error: "unauthorized" } }] });
    expect((await publish(denied.url)).code).toBe(1);
    server?.close();
    const noScope = await fakeKody({ publish: [dispatched], runs: [{ status: 403, body: { error: "insufficient_scope" } }] });
    const r = await publish(noScope.url);
    expect(r.code).toBe(1);
    expect(r.out).toContain("HTTP 403");
    server?.close();
    const { url } = await fakeKody({ publish: [ok(alreadyPublished)] });
    const missing = await publish(url, {}, "@missing/pkg");
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("not found");
  });

  it("needs a token", async () => {
    const r = await publish("http://127.0.0.1:9", { KODY_API_TOKEN: "" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Usage");
  });
});
