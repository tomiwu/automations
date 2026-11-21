import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "kody-check.mjs");
const FAKE_TOKEN = "kody_at_FAKE-token-for-tests";

type Answer = { status: number; body: unknown };
interface Plan {
  upload?: Answer[];
  check?: Answer[];
  runs?: Answer[];
}

let server: Server | undefined;
afterEach(() => server?.close());

const ok = (body: unknown): Answer => ({ status: 200, body });
const uploaded = ok({ upload_id: "up-1", object_key: "k", max_bytes: 25165824 });
const dispatched = ok({ status: "dispatched", workflow_id: "wf-1" });
const good = { ok: true, package_name: "@example/pkg", checks: [{ kind: "manifest", ok: true, message: "ok" }], notices: [] };
const bad = { ok: false, package_name: "@example/pkg", checks: [{ kind: "typecheck", ok: false, message: "bad type" }], notices: [] };
const running = ok({ status: "running", result: null, last_error: null });
const complete = (result: unknown) => ok({ status: "complete", result, last_error: null });
const ended = (status: string, last_error: string | null = null) => ok({ status, result: null, last_error });

/** A fake Kody API. Each list gives the answers in order; the last answer repeats. */
async function fakeKody(plan: Plan) {
  const seen: string[] = [];
  const bodies: Record<string, unknown> = {};
  const counts: Record<string, number> = {};
  const next = (key: string, list: Answer[]) => list[Math.min(counts[key] = (counts[key] ?? -1) + 1, list.length - 1)]!;
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization === `Bearer ${FAKE_TOKEN}`}`);
      const raw = Buffer.concat(chunks).toString();
      if (raw) bodies[`${req.method} ${req.url}`] = JSON.parse(raw);
      let answer: Answer = { status: 404, body: {} };
      if (req.method === "POST" && req.url === "/v1/packages/check-uploads") answer = next("upload", plan.upload ?? [uploaded]);
      else if (req.method === "POST" && req.url === "/v1/packages/check") answer = next("check", plan.check ?? [dispatched]);
      else if (req.method === "GET" && req.url === "/v1/packages/runs/wf-1") answer = next("runs", plan.runs ?? [complete(good)]);
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { seen, bodies, url: `http://127.0.0.1:${port}` };
}

function run(url: string, env: Record<string, string> = {}, input: unknown = { files: { "package.json": "{}" } }) {
  const dir = mkdtempSync(join(tmpdir(), "kody-check-"));
  writeFileSync(join(dir, "check.json"), JSON.stringify(input));
  const result = join(dir, "result.json");
  return new Promise<{ code: number | null; out: string; result: string }>((resolve) => {
    const child = spawn("node", [script, join(dir, "check.json"), result], {
      env: { PATH: process.env.PATH ?? "", KODY_API_TOKEN: FAKE_TOKEN, KODY_API_URL: url, KODY_CHECK_DELAYS_MS: "10,10", KODY_CHECK_POLL_MS: "10", KODY_CHECK_WAIT_MS: "5000", ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      let text = "";
      try { text = readFileSync(result, "utf8"); } catch { text = ""; }
      resolve({ code, out, result: text });
    });
  });
}

const polls = (seen: string[]) => seen.filter((s) => s.startsWith("GET /v1/packages/runs/")).length;

describe("kody-check.mjs", () => {
  it("uploads, dispatches the check with the upload id only, polls, and gives exit 0", async () => {
    const { seen, bodies, url } = await fakeKody({ runs: [running, running, complete(good)] });
    const r = await run(url, {}, { files: { "package.json": "{}" }, binary_contents: { "a.bin": "AAEC" } });
    expect(r.code).toBe(0);
    expect(seen.slice(0, 2)).toEqual(["POST /v1/packages/check-uploads true", "POST /v1/packages/check true"]);
    expect(polls(seen)).toBe(3);
    expect(bodies["POST /v1/packages/check-uploads"]).toEqual({ files: { "package.json": "{}" }, binary_contents: { "a.bin": "AAEC" } });
    expect(bodies["POST /v1/packages/check"]).toEqual({ upload_id: "up-1" });
    expect(JSON.parse(r.result)).toEqual(good);
    expect(JSON.parse(r.out).ok).toBe(true);
  });

  it("uses empty binary_contents when the input has none", async () => {
    const { bodies, url } = await fakeKody({});
    expect((await run(url)).code).toBe(0);
    expect(bodies["POST /v1/packages/check-uploads"]).toEqual({ files: { "package.json": "{}" }, binary_contents: {} });
  });

  it("gives exit 1 and prints the failed checks when ok is false", async () => {
    const { url } = await fakeKody({ runs: [complete(bad)] });
    const r = await run(url);
    expect(r.code).toBe(1);
    expect(r.out).toContain("bad type");
    expect(JSON.parse(r.result).ok).toBe(false);
  });

  it("takes a result that is there before the status is final", async () => {
    const { url } = await fakeKody({ runs: [ok({ status: "running", result: good })] });
    expect((await run(url)).code).toBe(0);
  });

  it.each([
    ["upload", { upload: [{ status: 400, body: { error: "bad" } }] }],
    ["upload (426)", { upload: [{ status: 426, body: { error: { code: "upgrade_required" } } }] }],
    ["check (426)", { check: [{ status: 426, body: { error: { code: "upgrade_required" } } }] }],
    ["check", { check: [{ status: 400, body: { error: "bad" } }] }],
    ["poll", { runs: [{ status: 403, body: { error: "insufficient_scope" } }] }],
  ] as [string, Plan][])("fails at once with exit 1 on 4xx at %s", async (_label, plan) => {
    const { seen, url } = await fakeKody(plan);
    const r = await run(url);
    expect(r.code).toBe(1);
    expect(r.out).toContain("refused");
    expect(seen.filter((line) => line.startsWith("POST") && line.includes("check-uploads"))).toHaveLength(1);
  });

  it("retries a 503 on upload and on check, then passes", async () => {
    const { seen, url } = await fakeKody({ upload: [{ status: 503, body: {} }, { status: 503, body: {} }, uploaded], check: [{ status: 429, body: {} }, dispatched] });
    const r = await run(url);
    expect(r.code).toBe(0);
    expect(seen.filter((s) => s.startsWith("POST /v1/packages/check-uploads"))).toHaveLength(3);
    expect(seen.filter((s) => s.startsWith("POST /v1/packages/check "))).toHaveLength(2);
    expect(r.out).toContain("upload attempt 1/3: HTTP 503");
  });

  it("gives exit 3 after three 503 answers", async () => {
    const { seen, url } = await fakeKody({ upload: [{ status: 503, body: {} }] });
    const r = await run(url);
    expect(r.code).toBe(3);
    expect(seen).toHaveLength(3);
    expect(r.out).toContain("unavailable after all attempts");
  });

  it("retries a 503 while it polls", async () => {
    const { url } = await fakeKody({ runs: [{ status: 503, body: {} }, running, complete(good)] });
    expect((await run(url)).code).toBe(0);
  });

  it("gives exit 3 when polling gets no usable answer", async () => {
    const { url } = await fakeKody({ runs: [{ status: 503, body: {} }] });
    const r = await run(url);
    expect(r.code).toBe(3);
    expect(r.out).toContain("no usable answer");
  });

  it("gives exit 3 when the run is unknown (status null)", async () => {
    const { url } = await fakeKody({ runs: [ok({ status: null })] });
    expect((await run(url)).code).toBe(3);
  });

  it.each(["errored", "terminated", "cancelled"])("gives exit 3 when the run ends %s without a result", async (status) => {
    const { url } = await fakeKody({ runs: [running, ended(status, "worker lost")] });
    const r = await run(url);
    expect(r.code).toBe(3);
    expect(r.out).toContain(`status=${status}`);
    expect(r.out).toContain("worker lost");
    expect(r.result).toBe("");
  });

  it("gives exit 3 when the wait limit is reached", async () => {
    const { url } = await fakeKody({ runs: [running] });
    const r = await run(url, { KODY_CHECK_WAIT_MS: "200" });
    expect(r.code).toBe(3);
    expect(r.out).toContain("not done within");
  });

  it("gives exit 3 when the answers lack an id", async () => {
    const noUpload = await fakeKody({ upload: [ok({})] });
    expect((await run(noUpload.url)).code).toBe(3);
    server?.close();
    const noWorkflow = await fakeKody({ check: [ok({ status: "dispatched" })] });
    expect((await run(noWorkflow.url)).code).toBe(3);
  });

  it("gives exit 3 when nobody answers, also after a timeout", async () => {
    const r = await run("http://127.0.0.1:9", { KODY_CHECK_TIMEOUT_MS: "200" });
    expect(r.code).toBe(3);
  });

  it("never prints the token", async () => {
    const { url } = await fakeKody({ upload: [{ status: 401, body: { error: `bad ${FAKE_TOKEN}` } }] });
    const r = await run(url);
    expect(r.code).toBe(1);
    expect(r.out).toContain("HTTP 401");
    expect(r.out).not.toContain(FAKE_TOKEN);
  });

  it("needs a token", async () => {
    const r = await run("http://127.0.0.1:9", { KODY_API_TOKEN: "" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Usage");
  });
});
