import { dirname, join } from "node:path";
import { DEFAULT_SORT, parseSort, type SortKey } from "./queue.ts";
import { DEFAULT_RETRY_DELAYS, parseDelays } from "./retry.ts";

export interface ModelSpec {
  provider: "claude" | "cursor";
  model: string;
}

export interface LoopConfig {
  repo: string | undefined;
  repoName: string;
  label: string;
  models: ModelSpec[];
  logDir: string;
  checks: string;
  image: string | undefined;
  sort: SortKey[];
  maxIterations: number;
  maxFixAttempts: number;
  skip: Set<number>;
  promptDir: string;
  /** Command of the sandbox-ready hook. Empty: no hook. A failure stops the sandbox (no `|| true`). */
  sandboxReady: string;
  /** gh command or wrapper on the host. */
  gh: string;
  /** git command or wrapper on the host. */
  git: string;
  /** Delays between the attempts of a host gh or git push call, in milliseconds. */
  retryDelaysMs: number[];
  /** Box-wide lock file around the checks, or undefined. */
  checksLock: string | undefined;
  /** Shell filter for the failed CI log (stdin to stdout), or undefined. */
  ciLogFilter: string | undefined;
  /** Doctor command. Empty: no doctor. */
  doctor: string;
  /** Re-run a failed CI one time before the fixer runs (network errors are not for the fixer). */
  ciRerun: boolean;
}

// Tomasz's order (9.11): Claude -> Cursor CLI Composer 2.5 -> Grok in the Cursor CLI. Local CLIs only.
// GROK_CURSOR_MODEL is the Grok id of the Cursor CLI. Check it with `agent --list-models`; change it here or in LOOP_MODELS.
export const GROK_CURSOR_MODEL = "grok-4.5-high";
export const DEFAULT_MODELS = `claude:claude-sonnet-5-5,cursor:composer-2.5,cursor:${GROK_CURSOR_MODEL}`;
export const DEFAULT_CHECKS =
  "npm ci --no-audit --no-fund && npm run typecheck && npm test && npm run crap";

export function parseModels(text: string): ModelSpec[] {
  const specs = text.split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [provider, ...rest] = entry.split(":");
    const model = rest.join(":");
    if ((provider !== "claude" && provider !== "cursor") || !model) {
      throw new Error(`Bad LOOP_MODELS entry: ${entry}. Use provider:model with provider claude or cursor.`);
    }
    return { provider, model } satisfies ModelSpec;
  });
  if (!specs.length) throw new Error("LOOP_MODELS has no model.");
  return specs;
}

export function repoNameOf(repo: string | undefined, cwd: string): string {
  const source = repo ?? cwd;
  return source.split("/").filter(Boolean).pop() ?? "repo";
}

function numberFrom(value: string | undefined, fallback: number): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

function text(env: Record<string, string | undefined>, key: string, fallback: string): string {
  return env[key] || fallback;
}

export const DEFAULT_SANDBOX_READY = "npm ci --no-audit --no-fund";

/** The value of the key, also when it is empty. The fallback only when the key is not set. */
function setOr(env: Record<string, string | undefined>, key: string, fallback: string): string {
  return env[key] ?? fallback;
}

export function loadConfig(env: Record<string, string | undefined>, cwd: string, defaultPromptDir: string): LoopConfig {
  const repo = env.LOOP_REPO || undefined;
  const repoName = repoNameOf(repo, cwd);
  return {
    repo,
    repoName,
    label: text(env, "LOOP_LABEL", "Sandcastle"),
    models: parseModels(text(env, "LOOP_MODELS", DEFAULT_MODELS)),
    logDir: text(env, "LOOP_LOG_DIR", `/workspace/loops/${repoName}`),
    checks: text(env, "LOOP_CHECKS", DEFAULT_CHECKS),
    image: env.LOOP_IMAGE || undefined,
    sort: parseSort(text(env, "LOOP_SORT", DEFAULT_SORT)),
    maxIterations: numberFrom(env.MAX_ITERATIONS, 10),
    maxFixAttempts: numberFrom(env.MAX_FIX_ATTEMPTS, 3),
    skip: new Set((env.SKIP_ISSUES ?? "").split(",").filter(Boolean).map(Number)),
    promptDir: text(env, "LOOP_PROMPT_DIR", defaultPromptDir),
    ...hostSettings(env, defaultPromptDir),
  };
}

type HostSettings = Pick<LoopConfig, "sandboxReady" | "gh" | "git" | "retryDelaysMs" | "checksLock" | "ciLogFilter" | "doctor" | "ciRerun">;

/** The host settings that differ per repository (hook, wrappers, retry, lock, CI log filter, doctor). */
function hostSettings(env: Record<string, string | undefined>, defaultPromptDir: string): HostSettings {
  return {
    sandboxReady: setOr(env, "LOOP_SANDBOX_READY", DEFAULT_SANDBOX_READY),
    gh: text(env, "LOOP_GH", "gh"),
    git: text(env, "LOOP_GIT", "git"),
    retryDelaysMs: parseDelays(text(env, "LOOP_RETRY_DELAYS", DEFAULT_RETRY_DELAYS)),
    checksLock: optional(env, "LOOP_CHECKS_LOCK"),
    ciLogFilter: optional(env, "LOOP_CI_LOG_FILTER"),
    doctor: setOr(env, "LOOP_DOCTOR", join(dirname(defaultPromptDir), "doctor.sh")),
    ciRerun: env.LOOP_CI_RERUN !== "0",
  };
}

function optional(env: Record<string, string | undefined>, key: string): string | undefined {
  return env[key] || undefined;
}
