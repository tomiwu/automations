#!/usr/bin/env node
// Publishes one Kody package and waits until the publish is done.
//   node tools/kody-deploy/kody-publish.mjs <@owner/name>
// It calls the same Open API operations as `kody package publish`: packageList (GET /v1/packages) and
// packagePublishExternalPush (POST /v1/packages/{package_id}/external-push).
// The publish is always durable: Kody answers "dispatched" with a workflow_id. The real answer (published,
// already_published or a refusal) is in the result of packageRunResult (GET /v1/packages/runs/{workflow_id}),
// which needs only the token scope package:read. A refused publish ends the run "errored" with the reason in
// last_error. An active publish is deduped by Kody, so a second POST joins the same run.
// Exit codes: 0 published or already_published, 1 refused, failed or not done in time.
// Environment: KODY_API_TOKEN (required, never printed), KODY_API_URL (default https://api.kody.codes),
// KODY_PUBLISH_POLL_MS (default 10000), KODY_PUBLISH_WAIT_MS (default 300000).
const [name] = process.argv.slice(2);
const token = process.env.KODY_API_TOKEN ?? "";
const base = (process.env.KODY_API_URL ?? "https://api.kody.codes").replace(/\/$/, "");
const pollMs = Number(process.env.KODY_PUBLISH_POLL_MS ?? 10000);
const waitMs = Number(process.env.KODY_PUBLISH_WAIT_MS ?? 300000);
const redact = (text) => (token ? String(text).split(token).join("***") : String(text));
const log = (line) => console.log(redact(line));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DONE = new Set(["published", "already_published"]);
const FINAL = new Set(["complete", "errored", "terminated", "cancelled"]);
const transient = (status) => status === 0 || status >= 500 || status === 429;
const deadline = performance.now() + waitMs;

async function call(method, path) {
  try {
    const headers = { accept: "application/json", authorization: `Bearer ${token}` };
    if (method === "POST") headers["content-type"] = "application/json";
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: method === "POST" ? "{}" : undefined,
      signal: AbortSignal.timeout(120000),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  } catch (error) {
    return { status: 0, json: null, text: String(error?.message ?? error) };
  }
}

function refused(what, r) {
  return new Error(`${what} refused: HTTP ${r.status}: ${redact(r.text).slice(0, 500)}`);
}

/** Calls until Kody gives a usable answer. It waits and tries again on 5xx, 429 and network errors. */
async function until(what, method, path) {
  for (;;) {
    const r = await call(method, path);
    if (r.status >= 200 && r.status < 300 && r.json) return r.json;
    if (!transient(r.status)) throw refused(what, r);
    log(`${what}: no answer (HTTP ${r.status}), try again`);
    await pause();
  }
}

async function pause() {
  if (performance.now() + pollMs >= deadline) throw new Error(`publish of ${name} not done within ${waitMs / 1000} s`);
  await sleep(pollMs);
}

async function packageId() {
  const body = await until("packageList", "GET", "/v1/packages");
  const found = (body.packages ?? []).find((p) => p.name === name);
  if (!found) throw new Error(`Package ${name} not found in Kody.`);
  return found.package_id;
}

function show(body) {
  const { status, published_commit, previous_commit, message, workflow_id } = body;
  log(JSON.stringify({ status, published_commit: published_commit ?? null, previous_commit: previous_commit ?? null, message: message ?? null, workflow_id: workflow_id ?? null }));
}

/** The answer of the publish: { status, ... } for a final answer or a refusal; a refusal throws. */
function judge(body) {
  if (DONE.has(body.status)) return body;
  throw new Error(`publish refused: status=${body.status}${body.message ? ` (${body.message})` : ""}`);
}

/** Reads the run until it has a result; a failed run throws with its last_error. */
async function waitForRun(workflowId) {
  for (;;) {
    const run = await until("packageRunResult", "GET", `/v1/packages/runs/${encodeURIComponent(workflowId)}`);
    log(`publish run ${workflowId}: status=${run.status ?? "unknown"}`);
    if (run.result && typeof run.result === "object") return judge(run.result);
    if (run.last_error) log(`last_error: ${run.last_error}`);
    if (FINAL.has(run.status) || run.status === null) {
      throw new Error(`publish run ${workflowId} ended with status=${run.status} and no result: ${run.last_error ?? "no reason"}`);
    }
    await pause();
  }
}

async function main() {
  const id = await packageId();
  log(`Publishing ${name}`);
  const start = await until("publish", "POST", `/v1/packages/${encodeURIComponent(id)}/external-push`);
  show(start);
  if (start.status === "dispatched" && !start.workflow_id) throw new Error("publish dispatched without workflow_id");
  const result = start.status === "dispatched" ? await waitForRun(start.workflow_id) : judge(start);
  if (result !== start) show(result);
  log(`done: ${result.status} ${result.published_commit ?? ""}`.trim());
}

if (!name || !token) {
  console.error("Usage: KODY_API_TOKEN=... kody-publish.mjs <@owner/name>");
  process.exit(1);
}
main().then(
  () => process.exit(0),
  (error) => {
    console.error(redact(error?.message ?? error));
    process.exit(1);
  },
);
