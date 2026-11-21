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
// (5xx, 429, network error or timeout after all attempts, a run that ended without a result, or the wait limit).
// Environment: KODY_API_TOKEN (required, never printed), KODY_API_URL (default https://api.kody.codes),
// KODY_CHECK_DELAYS_MS (waits between attempts of one request, default "5000,15000" = 3 attempts),
// KODY_CHECK_TIMEOUT_MS (per request, default 120000), KODY_CHECK_POLL_MS (poll interval, default 1500),
// KODY_CHECK_WAIT_MS (limit for the whole script, default 540000: less than the 10 min timeout of the workflow step,
// so that a deploy gets exit 3 and not a killed step).
import { readFileSync, writeFileSync } from "node:fs";
import { call, FINAL, hasResult, redact, refusal, runPath, sleep, token, transient, usable } from "./kody-api.mjs";

const [input, output] = process.argv.slice(2);
const delays = (process.env.KODY_CHECK_DELAYS_MS ?? "5000,15000").split(",").filter(Boolean).map(Number);
const timeoutMs = Number(process.env.KODY_CHECK_TIMEOUT_MS ?? 120000);
const pollMs = Number(process.env.KODY_CHECK_POLL_MS ?? 1500);
const waitMs = Number(process.env.KODY_CHECK_WAIT_MS ?? 540000);
const deadline = performance.now() + waitMs;
const left = () => deadline - performance.now();

/** A fatal outcome with its exit code. */
class Stop extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** One request; it never waits past the wait limit. */
const request = (method, path, payload) => call(method, path, payload, Math.min(timeoutMs, left()));
const describe = (r) => (r.status === 0 ? `no answer (${redact(r.text)})` : `HTTP ${r.status}`);

async function pause(ms) {
  if (ms >= left()) throw new Stop(3, `Kody check not done within ${waitMs / 1000} s`);
  await sleep(ms);
}

/** Calls one operation. It retries on 5xx, 429 and network errors; a 4xx stops with exit 1. */
async function step(label, method, path, payload) {
  for (let i = 0; i <= delays.length; i++) {
    const r = await request(method, path, payload);
    if (usable(r)) return r.json;
    if (!transient(r.status)) throw new Stop(1, refusal(`Kody ${label}`, r));
    console.error(`Kody ${label} attempt ${i + 1}/${delays.length + 1}: ${describe(r)}`);
    if (i < delays.length) await pause(delays[i]);
  }
  throw new Stop(3, `Kody ${label} unavailable after all attempts.`);
}

function readInput() {
  const parsed = JSON.parse(readFileSync(input, "utf8"));
  return { files: parsed.files ?? {}, binary_contents: parsed.binary_contents ?? {} };
}

function miss(why) {
  console.error(`Kody check run: ${why}`);
  return null;
}

/** Reads the run once. Returns the run, or null when it is not known yet or Kody gave no answer. */
async function readRun(workflowId) {
  const r = await request("GET", runPath(workflowId));
  if (usable(r)) return r.json.status == null ? miss("not known yet") : r.json;
  if (transient(r.status)) return miss(describe(r));
  throw new Stop(1, refusal("Kody check run", r));
}

/** The result of the run, or null while it runs. A run that ended without a result stops with exit 3. */
function resultOf(run, workflowId) {
  if (!run) return null;
  if (hasResult(run)) return run.result;
  if (!FINAL.has(run.status)) return null;
  throw new Stop(3, `Kody check run ${workflowId} ended with status=${run.status} and no result: ${redact(run.last_error ?? "no reason")}`);
}

async function waitForResult(workflowId) {
  for (let failures = 0; ; ) {
    const run = await readRun(workflowId);
    failures = run ? 0 : failures + 1;
    if (failures > delays.length) throw new Stop(3, "Kody check run: no usable answer after all attempts.");
    const result = resultOf(run, workflowId);
    if (result) return result;
    await pause(pollMs);
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
