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
import { call, FINAL, hasResult, redact, refusal, runPath, sleep, token, transient, usable } from "./kody-api.mjs";

const [name] = process.argv.slice(2);
const pollMs = Number(process.env.KODY_PUBLISH_POLL_MS ?? 10000);
const waitMs = Number(process.env.KODY_PUBLISH_WAIT_MS ?? 300000);
const log = (line) => console.log(redact(line));
const DONE = new Set(["published", "already_published"]);
const SHOWN = ["status", "published_commit", "previous_commit", "message", "workflow_id"];
const deadline = performance.now() + waitMs;

async function pause() {
  if (performance.now() + pollMs >= deadline) throw new Error(`publish of ${name} not done within ${waitMs / 1000} s`);
  await sleep(pollMs);
}

/** Calls until Kody gives a usable answer. It waits and tries again on 5xx, 429 and network errors. */
async function until(what, method, path, payload) {
  for (;;) {
    const r = await call(method, path, payload, 120000);
    if (usable(r)) return r.json;
    if (!transient(r.status)) throw new Error(refusal(what, r));
    log(`${what}: no answer (HTTP ${r.status}), try again`);
    await pause();
  }
}

async function packageId() {
  const body = await until("packageList", "GET", "/v1/packages");
  const found = (body.packages ?? []).find((p) => p.name === name);
  if (!found) throw new Error(`Package ${name} not found in Kody.`);
  return found.package_id;
}

const show = (body) => log(JSON.stringify(Object.fromEntries(SHOWN.map((key) => [key, body[key] ?? null]))));

/** Returns a published or already_published answer; any other status is a refusal and throws. */
function judge(body) {
  if (DONE.has(body.status)) return body;
  throw new Error(`publish refused: status=${body.status}${body.message ? ` (${body.message})` : ""}`);
}

/** Logs last_error; a run that ended without a result throws. */
function stopIfEnded(run, workflowId) {
  if (run.last_error) log(`last_error: ${run.last_error}`);
  if (FINAL.has(run.status) || run.status === null) {
    throw new Error(`publish run ${workflowId} ended with status=${run.status} and no result: ${run.last_error ?? "no reason"}`);
  }
}

async function waitForRun(workflowId) {
  for (;;) {
    const run = await until("packageRunResult", "GET", runPath(workflowId));
    log(`publish run ${workflowId}: status=${run.status ?? "unknown"}`);
    if (hasResult(run)) return judge(run.result);
    stopIfEnded(run, workflowId);
    await pause();
  }
}

/** The final answer: the first reply, or the result of the dispatched run. */
async function answer(start) {
  if (start.status !== "dispatched") return judge(start);
  if (!start.workflow_id) throw new Error("publish dispatched without workflow_id");
  const result = await waitForRun(start.workflow_id);
  show(result);
  return result;
}

async function main() {
  const id = await packageId();
  log(`Publishing ${name}`);
  const start = await until("publish", "POST", `/v1/packages/${encodeURIComponent(id)}/external-push`, {});
  show(start);
  const result = await answer(start);
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
