import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "kody-check.mjs");
const FAKE_TOKEN = "kody_at_FAKE-token-for-tests";

let server: Server | undefined;
afterEach(() => server?.close());

/** A fake Kody API that answers each request with the next status of the list. */
async function fakeKody(statuses: number[], body = { ok: true, package_name: "@example/pkg", checks: [{ kind: "manifest", ok: true, message: "ok" }] }) {
  const seen: string[] = [];
  server = createServer((req, res) => {
    seen.push(`${req.method} ${req.url} ${req.headers.authorization === `Bearer ${FAKE_TOKEN}`}`);
    const status = statuses[Math.min(seen.length - 1, statuses.length - 1)]!;
    res.writeHead(status, { "content-type": "application/json" });
    res.end(status === 200 ? JSON.stringify(body) : `{"error":"status ${status}"}`);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { seen, url: `http://127.0.0.1:${port}` };
}

function run(url: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "kody-check-"));
  writeFileSync(join(dir, "check.json"), JSON.stringify({ files: { "package.json": "{}" } }));
  const result = join(dir, "result.json");
  return new Promise<{ code: number | null; out: string; result: string }>((resolve) => {
    const child = spawn("node", [script, join(dir, "check.json"), result], {
      env: { PATH: process.env.PATH ?? "", KODY_API_TOKEN: FAKE_TOKEN, KODY_API_URL: url, KODY_CHECK_DELAYS_MS: "10,10", ...env },
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

describe("kody-check.mjs", () => {
  it("passes after two 503 answers", async () => {
    const { seen, url } = await fakeKody([503, 503, 200]);
    const r = await run(url);
    expect(r.code).toBe(0);
    expect(seen).toEqual(Array(3).fill("POST /v1/packages/check true"));
    expect(JSON.parse(r.result).ok).toBe(true);
    expect(r.out).toContain("attempt 1/3: HTTP 503");
  });

  it("gives exit 3 after three 503 answers", async () => {
    const { seen, url } = await fakeKody([503]);
    const r = await run(url);
    expect(r.code).toBe(3);
    expect(seen).toHaveLength(3);
    expect(r.out).toContain("unavailable after all attempts");
  });

  it("retries on 429", async () => {
    const { seen, url } = await fakeKody([429, 200]);
    expect((await run(url)).code).toBe(0);
    expect(seen).toHaveLength(2);
  });

  it("fails at once on 401 and does not print the token", async () => {
    const { seen, url } = await fakeKody([401]);
    const r = await run(url);
    expect(r.code).toBe(1);
    expect(seen).toHaveLength(1);
    expect(r.out).toContain("HTTP 401");
    expect(r.out).not.toContain(FAKE_TOKEN);
  });

  it("gives exit 1 when the checks fail", async () => {
    const { url } = await fakeKody([200], { ok: false, package_name: "@example/pkg", checks: [{ kind: "typecheck", ok: false, message: "bad type" }] });
    const r = await run(url);
    expect(r.code).toBe(1);
    expect(r.out).toContain("bad type");
  });

  it("gives exit 3 when nobody answers, also after a timeout", async () => {
    const r = await run("http://127.0.0.1:9", { KODY_CHECK_TIMEOUT_MS: "200" });
    expect(r.code).toBe(3);
  });

  it("needs a token", async () => {
    const r = await run("http://127.0.0.1:9", { KODY_API_TOKEN: "" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("Usage");
  });
});
