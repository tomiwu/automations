#!/usr/bin/env node
// Runs the Kody publish checks (POST /v1/packages/check, saves nothing) with retries.
//   node tools/kody-deploy/kody-check.mjs <check.json> <result.json>
// Exit codes: 0 checks ok, 1 checks failed or the request was refused (4xx), 3 Kody did not answer
// (5xx, 429, network error or timeout after all attempts).
// Environment: KODY_API_TOKEN (required, never printed), KODY_API_URL (default https://api.kody.codes),
// KODY_CHECK_DELAYS_MS (waits between attempts, default "5000,15000" = 3 attempts),
// KODY_CHECK_TIMEOUT_MS (per attempt, default 120000).
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
const token = process.env.KODY_API_TOKEN ?? "";
const base = process.env.KODY_API_URL ?? "https://api.kody.codes";
const delays = (process.env.KODY_CHECK_DELAYS_MS ?? "5000,15000").split(",").filter(Boolean).map(Number);
const timeoutMs = Number(process.env.KODY_CHECK_TIMEOUT_MS ?? 120000);
const redact = (text) => (token ? text.split(token).join("***") : text);

if (!input || !output || !token) {
  console.error("Usage: KODY_API_TOKEN=... kody-check.mjs <check.json> <result.json>");
  process.exit(1);
}

const body = readFileSync(input, "utf8");
const transient = (status) => status >= 500 || status === 429;

async function attempt() {
  try {
    const response = await fetch(`${base}/v1/packages/check`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    return { status: 0, text: String(error?.message ?? error) };
  }
}

function report(text) {
  writeFileSync(output, text);
  const result = JSON.parse(text);
  const checks = (result.checks ?? []).map((c) => ({ kind: c.kind, ok: c.ok, message: c.message }));
  console.log(JSON.stringify({ ok: result.ok, package_name: result.package_name, checks }, null, 2));
  return result.ok === true ? 0 : 1;
}

for (let i = 0; i <= delays.length; i++) {
  const { status, text } = await attempt();
  if (status >= 200 && status < 300) process.exit(report(text));
  const why = status === 0 ? `no answer (${redact(text)})` : `HTTP ${status}`;
  if (status !== 0 && !transient(status)) {
    console.error(`Kody check refused: ${why}: ${redact(text).slice(0, 500)}`);
    process.exit(1);
  }
  console.error(`Kody check attempt ${i + 1}/${delays.length + 1}: ${why}`);
  if (i < delays.length) await new Promise((resolve) => setTimeout(resolve, delays[i]));
}
console.error("Kody check unavailable after all attempts.");
process.exit(3);
