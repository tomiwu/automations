// Environment: KODY_API_TOKEN (never printed), KODY_API_URL (default https://api.kody.codes).
export const token = process.env.KODY_API_TOKEN ?? "";
const base = (process.env.KODY_API_URL ?? "https://api.kody.codes").replace(/\/$/, "");

export const FINAL = new Set(["complete", "errored", "terminated", "cancelled"]);
export const redact = (text) => (token ? String(text).split(token).join("***") : String(text));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const transient = (status) => status === 0 || status >= 500 || status === 429;
export const usable = (r) => r.status >= 200 && r.status < 300 && Boolean(r.json);
export const hasResult = (run) => Boolean(run.result) && typeof run.result === "object";
export const runPath = (workflowId) => `/v1/packages/runs/${encodeURIComponent(workflowId)}`;
export const refusal = (label, r) => `${label} refused: HTTP ${r.status}: ${redact(r.text).slice(0, 500)}`;

function options(method, payload, timeoutMs) {
  const init = { method, headers: { accept: "application/json", authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(timeoutMs) };
  if (payload !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(payload);
  }
  return init;
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function call(method, path, payload, timeoutMs) {
  try {
    const response = await fetch(`${base}${path}`, options(method, payload, Math.max(0, Math.floor(timeoutMs))));
    const text = await response.text();
    return { status: response.status, json: parseJson(text), text };
  } catch (error) {
    return { status: 0, json: null, text: String(error?.message ?? error) };
  }
}
