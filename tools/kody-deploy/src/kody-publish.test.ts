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
const done = ok({ status: "already_published", published_commit: "c0ffee1" });
const noScope: Answer = { status: 403, body: { error: "insufficient_scope", message: 'this token is missing "job:read"' } };
const run = (status: string, extra: Record<string, unknown> = {}) => ok({ workflows: [{ id: "dynwf-1", status, enqueued_commit: "c0ffee1", last_error: null, ...extra }] });

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
    else if (req.url === "/v1/workflow-runs?workflow_id=dynwf-1") answer = next(plan.runs ?? [noScope], "runs");
    res.writeHead(answer.status, { "content-type": "application/json" });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { seen, url: `http://127.0.0.1:${port}` };
}

function publish(url: string, env: Record<string, string> = {}) {
  const started = Date.now();
  return new Promise<{ code: number | null; out: string; ms: number }>((resolve) => {
    const child = spawn("node", [script, PKG], {
      env: { PATH: process.env.PATH ?? "", KODY_API_TOKEN: FAKE_TOKEN, KODY_API_URL: url, KODY_PUBLISH_POLL_MS: "20", KODY_PUBLISH_WAIT_MS: "5000", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code, out, ms: Date.now() - started }));
  });
}

const posts = (seen: string[]) => seen.filter((s) => s.startsWith("POST")).length;
const statusReads = (seen: string[]) => seen.filter((s) => s.includes("workflow-runs")).length;

describe("kody-publish.mjs", () => {
  it("returns at once when the package is already published", async () => {
    const { seen, url } = await fakeKody({ publish: [done] });
    const r = await publish(url);
    expect(r.code).toBe(0);
    expect(seen).toEqual(["GET /v1/packages", "POST /v1/packages/pkg-1/external-push"]);
    expect(r.out).toContain("done: already_published c0ffee1");
  });

  it("reads the real job status and stops when it is complete", async () => {
    const { seen, url } = await fakeKody({ publish: [dispatched, done], runs: [run("running"), run("complete")] });
    const r = await publish(url);
    expect(r.code).toBe(0);
    expect(statusReads(seen)).toBe(2);
    expect(posts(seen)).toBe(2);
    expect(r.out).toContain("status=running");
    expect(r.out).toContain("status=complete");
  });

  it("stops reading the status after insufficient_scope and is done on the next already_published, in less than 1 minute", async () => {
    const { seen, url } = await fakeKody({ publish: [dispatched, done], runs: [noScope] });
    const r = await publish(url, { KODY_PUBLISH_POLL_MS: "10000", KODY_PUBLISH_WAIT_MS: "300000" });
    expect(r.code).toBe(0);
    expect(statusReads(seen)).toBe(1);
    expect(posts(seen)).toBe(2);
    expect(r.ms).toBeLessThan(60000);
    expect(r.out).toContain("cannot give the status (insufficient_scope)");
  }, 30000);

  it("publishes again while Kody still answers dispatched, without status reads", async () => {
    const { seen, url } = await fakeKody({ publish: [dispatched, dispatched, dispatched, done], runs: [noScope] });
    const r = await publish(url);
    expect(r.code).toBe(0);
    expect(statusReads(seen)).toBe(1);
    expect(posts(seen)).toBe(4);
  });

  it("publishes once more after a failed background job, then fails on a second failure", async () => {
    const repaired = await fakeKody({ publish: [dispatched, done], runs: [run("errored", { last_error: "artifact missing" })] });
    const first = await publish(repaired.url);
    expect(first.code).toBe(0);
    expect(first.out).toContain("last_error: artifact missing");
    server?.close();
    const broken = await fakeKody({ publish: [dispatched, dispatched], runs: [run("errored")] });
    const second = await publish(broken.url);
    expect(second.code).toBe(1);
    expect(second.out).toContain("ended with status=errored");
  });

  it("fails on a refusal and on a timeout", async () => {
    const refused = await fakeKody({ publish: [ok({ status: "checks_failed", message: "typecheck" })] });
    const r1 = await publish(refused.url);
    expect(r1.code).toBe(1);
    expect(r1.out).toContain("status=checks_failed");
    server?.close();
    const slow = await fakeKody({ publish: [dispatched], runs: [run("running")] });
    const r2 = await publish(slow.url, { KODY_PUBLISH_WAIT_MS: "200" });
    expect(r2.code).toBe(1);
    expect(r2.out).toContain("not done within");
  });

  it("tries again on 503 and never prints the token", async () => {
    const { url } = await fakeKody({ publish: [{ status: 503, body: { error: FAKE_TOKEN } }, done] });
    const r = await publish(url);
    expect(r.code).toBe(0);
    expect(r.out).toContain("no answer (HTTP 503)");
    expect(r.out).not.toContain(FAKE_TOKEN);
  });

  it("fails at once on 401 and when the package is unknown", async () => {
    const denied = await fakeKody({ publish: [{ status: 401, body: { error: "unauthorized" } }] });
    expect((await publish(denied.url)).code).toBe(1);
    server?.close();
    const { url } = await fakeKody({ publish: [done] });
    const child = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const p = spawn("node", [script, "@missing/pkg"], { env: { PATH: process.env.PATH ?? "", KODY_API_TOKEN: FAKE_TOKEN, KODY_API_URL: url } });
      let out = "";
      p.stderr.on("data", (d) => (out += d));
      p.on("close", (code) => resolve({ code, out }));
    });
    expect(child.code).toBe(1);
    expect(child.out).toContain("not found");
  });

  it("needs a token", async () => {
    const r = await publish("http://127.0.0.1:9", { KODY_API_TOKEN: "" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Usage");
  });
});
