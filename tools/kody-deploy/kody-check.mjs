#!/usr/bin/env node
// Runs the Kody publish checks (durable flow, saves nothing) with retries.
//   node tools/kody-deploy/kody-check.mjs <check.json> <result.json>
// <check.json> is { "files": { path: utf8 }, "binary_contents"?: { path: base64 } }, paths relative to the package root.
// Flow (the same as `kody package check` in @kodycodes/cli >= 3.46.0):
//   1. POST /v1/packages/check-uploads  { files, binary_contents }  -> { upload_id }
//   2. POST /v1/packages/check          { upload_id }               -> { status: "dispatched", workflow_id }
//   3. GET  /v1/packages/runs/{workflow_id} until result is an object or the run has a final status.
// The final result ({ ok, package_name, checks, notices }) is written to <result.json>.
// Exit codes: 0 checks ok, 1 checks failed or the request was refused (4xx), 3 Kody did not answer
// (5xx, 429, network error or timeout after all attempts, or a run that ended without a result).
// Environment: KODY_API_TOKEN (required, never printed), KODY_API_URL (default https://api.kody.codes),
// KODY_CHECK_DELAYS_MS (waits between attempts of one request, default "5000,15000" = 3 attempts),
// KODY_CHECK_TIMEOUT_MS (per request, default 120000), KODY_CHECK_POLL_MS (poll interval, default 1500),
// KODY_CHECK_WAIT_MS (limit for the whole run, default 600000).
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
const token = process.env.KODY_API_TOKEN ?? "";
const base = (process.env.KODY_API_URL ?? "https://api.kody.codes").replace(/\/$/, "");
const delays = (process.env.KODY_CHECK_DELAYS_MS ?? "5000,15000").split(",").filter(Boolean).map(Number);
const timeoutMs = Number(process.env.KODY_CHECK_TIMEOUT_MS ?? 120000);
const pollMs = Number(process.env.KODY_CHECK_POLL_MS ?? 1500);
const waitMs = Number(process.env.KODY_CHECK_WAIT_MS ?? 600000);
const FINAL = new Set(["complete", "errored", "terminated", "cancelled"]);
const redact = (text) => (token ? String(text).split(token).join("***") : String(text));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const transient = (status) => status === 0 || status >= 500 || status === 429;

/** A fatal outcome with its exit code. */
class Stop extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** One HTTP request. Never throws: a network error or timeout gives status 0. */
async function call(method, path, payload) {
  try {
    const headers = { accept: "application/json", authorization: `Bearer ${token}` };
    if (payload !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    return { status: response.status, json: parseJson(text), text };
  } catch (error) {
    return { status: 0, json: null, text: String(error?.message ?? error) };
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function describe(r) {
  return r.status === 0 ? `no answer (${redact(r.text)})` : `HTTP ${r.status}`;
}

/** Calls one operation. It retries on 5xx, 429 and network errors; a 4xx stops with exit 1. */
async function step(label, method, path, payload) {
  for (let i = 0; i <= delays.length; i++) {
    const r = await call(method, path, payload);
    if (r.status >= 200 && r.status < 300 && r.json) return r.json;
    if (!transient(r.status)) throw new Stop(1, `Kody ${label} refused: ${describe(r)}: ${redact(r.text).slice(0, 500)}`);
    console.error(`Kody ${label} attempt ${i + 1}/${delays.length + 1}: ${describe(r)}`);
    if (i < delays.length) await sleep(delays[i]);
  }
  throw new Stop(3, `Kody ${label} unavailable after all attempts.`);
}

function readInput() {
  const parsed = JSON.parse(readFileSync(input, "utf8"));
  return { files: parsed.files ?? {}, binary_contents: parsed.binary_contents ?? {} };
}

/** Reads the run once. Returns the run body, or null when Kody gave no usable answer (transient). */
async function readRun(workflowId) {
  const r = await call("GET", `/v1/packages/runs/${encodeURIComponent(workflowId)}`);
  if (r.status >= 200 && r.status < 300 && r.json && r.json.status !== null && r.json.status !== undefined) return r.json;
  if (r.status >= 200 && r.status < 300 && r.json) console.error("Kody check run: not known yet");
  else if (transient(r.status)) console.error(`Kody check run: ${describe(r)}`);
  else throw new Stop(1, `Kody check run refused: ${describe(r)}: ${redact(r.text).slice(0, 500)}`);
  return null;
}

/** Polls the run until it has a result. */
async function waitForResult(workflowId) {
  const deadline = performance.now() + waitMs;
  let failures = 0;
  for (;;) {
    const run = await readRun(workflowId);
    failures = run ? 0 : failures + 1;
    if (run && run.result && typeof run.result === "object") return run.result;
    if (run && FINAL.has(run.status)) {
      throw new Stop(3, `Kody check run ${workflowId} ended with status=${run.status} and no result: ${redact(run.last_error ?? "no reason")}`);
    }
    if (failures > delays.length) throw new Stop(3, "Kody check run: no usable answer after all attempts.");
    if (performance.now() + pollMs >= deadline) throw new Stop(3, `Kody check not done within ${waitMs / 1000} s`);
    await sleep(pollMs);
  }
}

function report(result) {
  writeFileSync(output, JSON.stringify(result));
  const checks = (result.checks ?? []).map((c) => ({ kind: c.kind, ok: c.ok, message: c.message }));
  console.log(JSON.stringify({ ok: result.ok, package_name: result.package_name, checks }, null, 2));
  return result.ok === true ? 0 : 1;
}

async function main() {
  const upload = await step("upload", "POST", "/v1/packages/check-uploads", readInput());
  if (!upload.upload_id) throw new Stop(3, "Kody upload answered without upload_id.");
  const started = await step("check", "POST", "/v1/packages/check", { upload_id: upload.upload_id });
  if (!started.workflow_id) throw new Stop(3, `Kody check answered without workflow_id (status=${started.status}).`);
  return report(await waitForResult(started.workflow_id));
}

if (!input || !output || !token) {
  console.error("Usage: KODY_API_TOKEN=... kody-check.mjs <check.json> <result.json>");
  process.exit(1);
}
main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(redact(error?.message ?? error));
    process.exit(error instanceof Stop ? error.code : 1);
  },
);
