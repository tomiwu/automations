import { DEFAULT_SORT, parseSort, type SortKey } from "./queue.ts";

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
}

export const DEFAULT_MODELS = "claude:claude-sonnet-5-5,cursor:composer-2.5";
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
  };
}
