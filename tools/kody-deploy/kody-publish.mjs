#!/usr/bin/env node
// Publishes one Kody package and waits until the publish is done.
//   node tools/kody-deploy/kody-publish.mjs <@owner/name>
// It calls the same Open API operations as `kody package publish`: packageList (GET /v1/packages) and
// packagePublishExternalPush (POST /v1/packages/{package_id}/external-push).
// When Kody hands the publish off to a background job ("dispatched"), it reads the job status with
// workflowRunList (GET /v1/workflow-runs?workflow_id=...). That needs the token scope job:read. When the status
// cannot be read (for example insufficient_scope), it stops reading it at once and publishes again at each
// interval: Kody dedupes an active publish, and a finished one answers already_published.
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
const FAILED_RUN = new Set(["errored", "terminated", "cancelled"]);

if (!name || !token) {
  console.error("Usage: KODY_API_TOKEN=... kody-publish.mjs <@owner/name>");
  process.exit(1);
}

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

async function packageId() {
  const r = await call("GET", "/v1/packages");
  const found = (r.json?.packages ?? []).find((p) => p.name === name);
  if (!found) throw new Error(`Package ${name} not found in Kody (HTTP ${r.status}).`);
  return found.package_id;
}

/** One publish. Returns the API body, { status: "retry" } on 5xx/429/network, or throws on a refusal. */
async function publish(id) {
  const r = await call("POST", `/v1/packages/${encodeURIComponent(id)}/external-push`);
  if (r.status === 0 || r.status >= 500 || r.status === 429) {
    log(`publish: no answer (HTTP ${r.status}), try again`);
    return { status: "retry" };
  }
  if (r.status >= 400 || !r.json) throw new Error(`publish refused: HTTP ${r.status}: ${redact(r.text).slice(0, 500)}`);
  const { status, published_commit, previous_commit, message, workflow_id } = r.json;
  log(JSON.stringify({ status, published_commit: published_commit ?? null, previous_commit: previous_commit ?? null, message: message ?? null, workflow_id: workflow_id ?? null }));
  if (DONE.has(status) || status === "dispatched") return r.json;
  throw new Error(`publish refused: status=${status}`);
}

/** The status of the background job, or null when it cannot be read. */
async function runStatus(workflowId) {
  const r = await call("GET", `/v1/workflow-runs?workflow_id=${encodeURIComponent(workflowId)}`);
  const run = r.json?.workflows?.[0];
  if (r.status !== 200 || !run) {
    const why = r.json?.error ?? r.json?.code ?? `HTTP ${r.status}`;
    log(`workflowRunList cannot give the status (${why}); publish again to read the state`);
    return null;
  }
  log(`background job ${workflowId}: status=${run.status} enqueued_commit=${run.enqueued_commit ?? "n/a"}`);
  if (run.last_error) log(`last_error: ${run.last_error}`);
  return run.status;
}

async function main() {
  const id = await packageId();
  log(`Publishing ${name}`);
  let result = await publish(id);
  let workflowId = result.workflow_id ?? null;
  let readStatus = true;
  let repairs = 0;
  const deadline = performance.now() + waitMs;
  while (!DONE.has(result.status)) {
    if (performance.now() >= deadline) throw new Error(`publish of ${name} not done within ${waitMs / 1000} s`);
    await sleep(pollMs);
    if (readStatus && workflowId) {
      const status = await runStatus(workflowId);
      if (status === null) readStatus = false;
      else if (FAILED_RUN.has(status)) {
        if (repairs++ > 0) throw new Error(`background publish ended with status=${status}`);
        log("background publish failed; publish once more (Kody repairs missing artifacts on a re-run)");
      } else if (status !== "complete") continue;
    }
    result = await publish(id);
    if (result.workflow_id) workflowId = result.workflow_id;
  }
  log(`done: ${result.status} ${result.published_commit ?? ""}`.trim());
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(redact(error?.message ?? error));
    process.exit(1);
  },
);
