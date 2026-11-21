// automations Sandcastle loop: implement -> review -> check -> PR -> merge.
//
// For each iteration, the host does these steps:
//   1. Select the open issue with the "Sandcastle" label that has no open
//      "Blocked by #N" issue. Take the highest priority label, then the lowest number.
//   2. Create a sandbox on the branch "sandcastle/issue-<N>".
//   3. Run the implementer agent, then the reviewer agent.
//   4. Run the checks in the sandbox at the workspace root (npm workspaces):
//      `npm ci`, `npm run typecheck`, `npm test` and `npm run crap` (CRAP < 6).
//   5. If a check fails, run the fixer agent. Retry up to MAX_FIX_ATTEMPTS.
//   6. Push the branch, open a PR, wait for CI, squash-merge, close the issue.
// The loop never publishes or deploys to Kody. The loop never reads Kody secrets.
// The loop stops when no issue is ready, or when an issue cannot pass.
//
// Usage:
//   MAX_ITERATIONS=10 npx tsx .sandcastle/main.mts                (default: Claude Code, Sonnet 5.5)
//   AGENT=cursor MAX_ITERATIONS=10 npx tsx .sandcastle/main.mts   (option: Cursor, Composer 2.5 Fast)
//   DRY_RUN=1 npx tsx .sandcastle/main.mts                        (print the next issue and the packages, run no agent)
// If the Cursor agent fails because of credits or limits, the loop changes to Claude.
//
// Loop policy (tomiwu 2026-11-13, review of the Lydia Hallie talk; helpers in loop-policy.mts):
// - Claude limit: the loop parses the reset time ("resets 6:30pm (UTC)") and pauses until it on
//   the wall clock (a box suspend does not freeze the wait), then retries. It skips the other
//   Claude models (CLAUDE_FALLBACK_MODEL) on a limit: they share the same subscription limit.
// - Claude Code reads the committed .claude/settings.json: permissions.deny and a Stop hook.
//   The hook is active only with LOOP_STOP_GATE=1 (this loop sets it). It returns exit 2 until
//   there is a commit, the tree is clean, a ## Verification section exists, and typecheck/tests
//   of the changed workspaces pass. One forced retry (stop_hook_active).
// - Effort per phase (EFFORT_<PHASE>), REVIEW_MODEL for the reviewer (default claude-opus-5-5).
// - Status file STATUS_FILE (JSON: phase, model, issue, startedAt, lastOutputAt).

import * as sandcastle from "@ai-hero/sandcastle";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CLAUDE_LIMIT, LIMIT_ERROR, effortFor, isClaudeLabel, limitWait, modelOfLabel, nextAgentAfterStall, phaseOfName, sleepUntil, stallKind, writeStatus,
} from "./loop-policy.mts";

const MAX_ITERATIONS = Number(process.env.MAX_ITERATIONS ?? "10");
const MAX_FIX_ATTEMPTS = Number(process.env.MAX_FIX_ATTEMPTS ?? "3");
const CURSOR_MODEL = process.env.CURSOR_MODEL ?? "composer-2.5-fast";
// tomiwu 2026-11-13: next work on Opus 5.5. The start script can set another model.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-5-5";
const CLAUDE_FALLBACK_MODEL = process.env.CLAUDE_FALLBACK_MODEL ?? "";
const REVIEW_MODEL = process.env.REVIEW_MODEL ?? "claude-opus-5-5";
const PAUSE_MINUTES = Number(process.env.PAUSE_MINUTES ?? "30");
const MAX_PAUSES = Number(process.env.MAX_PAUSES ?? "12");
const LIMIT_MAX_HOURS = Number(process.env.LIMIT_MAX_HOURS ?? "6");
const STATUS_FILE = process.env.STATUS_FILE ?? "/tmp/automations-loop.status.json";

interface PhaseOpts { effort: ReturnType<typeof effortFor>; env: Record<string, string> }
type Provider = ReturnType<typeof sandcastle.cursor>;
const claude = (model: string) => (o?: PhaseOpts): Provider =>
  sandcastle.claudeCode(model, o ? { effort: o.effort, env: o.env } : undefined);
const cursorAgent = { label: `Cursor CLI (${CURSOR_MODEL})`, make: (): Provider => sandcastle.cursor(CURSOR_MODEL) };
const claudeAgents = [
  { label: `Claude Code (${CLAUDE_MODEL})`, make: claude(CLAUDE_MODEL) },
  ...(CLAUDE_FALLBACK_MODEL && CLAUDE_FALLBACK_MODEL !== CLAUDE_MODEL ? [{ label: `Claude Code (${CLAUDE_FALLBACK_MODEL})`, make: claude(CLAUDE_FALLBACK_MODEL) }] : []),
];
// AGENT=cursor: Cursor first, then Claude. Default: Claude only (the automations .env has no Cursor key).
const AGENTS: { label: string; make: (o?: PhaseOpts) => Provider }[] = process.env.AGENT === "cursor" ? [cursorAgent, ...claudeAgents] : claudeAgents;
const LABELS = AGENTS.map((a) => a.label);
let agentIndex = 0;
let pauses = 0;
let currentIssue: number | null = null;
let loopStatus = { phase: "start", startedAt: new Date().toISOString(), lastOutputAt: null as string | null, note: "" };
function saveStatus(): void {
  const label = AGENTS[agentIndex].label;
  writeStatus(STATUS_FILE, { ...loopStatus, model: modelOfLabel(label), agent: label, issue: currentIssue, pid: process.pid });
}

type RunOptions = Omit<Parameters<sandcastle.Sandbox["run"]>[0], "agent">;

// Run one agent phase. On a stall (limit, invalid key or login, idle timeout; see stallKind), change to
// the next agent; a Claude limit or login error skips the other Claude models. When no agent is left,
// pause until the parsed reset time (wall clock) and retry. Other errors are thrown.
async function runPhase(sandbox: sandcastle.Sandbox, options: RunOptions & { checkLog?: string }) {
  const { checkLog = "", ...runOptions } = options;
  const name = options.name ?? "phase";
  const baseSha = (await sandbox.exec("git rev-parse HEAD")).stdout.trim();
  for (;;) {
    const o: PhaseOpts = { effort: effortFor(phaseOfName(name, checkLog)), env: { LOOP_STOP_GATE: "1", LOOP_PHASE: name, LOOP_BASE_SHA: baseSha } };
    const a = AGENTS[agentIndex];
    const useReview = name === "reviewer" && isClaudeLabel(a.label) && REVIEW_MODEL;
    const label = useReview ? `Claude Code (${REVIEW_MODEL})` : a.label;
    const provider = useReview ? claude(REVIEW_MODEL)(o) : a.make(o);
    loopStatus = { phase: name, startedAt: new Date().toISOString(), lastOutputAt: null, note: `${label}, effort ${o.effort}` };
    saveStatus();
    const beat = setInterval(() => {
      const f = newestLog(name);
      try { if (f) { loopStatus.lastOutputAt = new Date(statSync(f).mtimeMs).toISOString(); saveStatus(); } } catch { /* next beat */ }
    }, 30_000);
    let failure = "";
    let kind = "limit";
    try {
      const result = await sandbox.run({ idleTimeoutSeconds: 1800, ...runOptions, agent: provider });
      const tail = logTail(name);
      if (result.commits.length || !LIMIT_ERROR.test(tail)) return result;
      failure = `limit text in the agent log: ${tail.match(new RegExp(`.{0,80}(?:${LIMIT_ERROR.source}).{0,120}`, "i"))?.[0] ?? ""}`;
    } catch (error) {
      failure = `${error} ${logTail(name).slice(-600)}`;
      const stall = stallKind(failure);
      if (!stall) throw error;
      kind = stall;
    } finally {
      clearInterval(beat);
    }
    console.log(`${label} stalled in ${name} (${kind}): ${failure.slice(0, 300)}`);
    let until = Date.now() + PAUSE_MINUTES * 60_000;
    if (isClaudeLabel(a.label) && CLAUDE_LIMIT.test(failure)) {
      const w = limitWait(failure, Date.now(), PAUSE_MINUTES, LIMIT_MAX_HOURS);
      until = w.untilMs;
      console.log(`Claude limit: ${w.reason}.`);
    }
    const next = nextAgentAfterStall(LABELS, agentIndex, failure);
    if (next >= 0) { agentIndex = next; console.log(`Agent: ${AGENTS[agentIndex].label} (fallback).`); continue; }
    if (pauses >= MAX_PAUSES) throw new Error(`All agents stalled ${MAX_PAUSES + 1} times. Last error: ${failure.slice(0, 300)}`);
    pauses++;
    console.log(`All agents stalled. Pause until ${new Date(until).toISOString()} on the wall clock (pause ${pauses}/${MAX_PAUSES}).`);
    loopStatus = { ...loopStatus, phase: "pause", note: `until ${new Date(until).toISOString()}` };
    saveStatus();
    await sleepUntil(until);
    agentIndex = 0;
  }
}

function newestLog(name?: string): string | undefined {
  try {
    const dir = ".sandcastle/logs";
    return readdirSync(dir).filter((f) => name && f.endsWith(`-${name}.log`))
      .map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch {
    return undefined;
  }
}

function logTail(name?: string): string {
  const file = newestLog(name);
  try { return file ? readFileSync(file, "utf8").slice(-4000) : ""; } catch { return ""; }
}
const LABEL = "Sandcastle";
// Issues to skip, for example issues that must change .github/ (GH_TOKEN has no Workflows permission).
const SKIP = new Set((process.env.SKIP_ISSUES ?? "").split(",").filter(Boolean).map(Number));

const hooks = {
  sandbox: {
    onSandboxReady: [
      { command: "npm ci --no-audit --no-fund || true" },
      { command: "bash scripts/install-hooks.sh" },
    ],
  },
};

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}

interface Issue { number: number; title: string; body: string; labels: { name: string }[] }

// Priority from labels. An issue without a priority label is medium.
const PRIORITY: Record<string, number> = {
  "priority: critical": 0, "priority: high": 1, "priority: medium": 2, "priority: low": 3,
};
function priority(issue: Issue): number {
  const values = issue.labels.map((l) => PRIORITY[l.name]).filter((v) => v !== undefined);
  return values.length ? Math.min(...values) : PRIORITY["priority: medium"];
}

function nextIssue(merged: Set<number>): Issue | undefined {
  const open: Issue[] = JSON.parse(
    sh("gh", ["issue", "list", "--state", "open", "--label", LABEL, "--limit", "100", "--json", "number,title,body,labels"]),
  );
  const openNumbers = new Set(open.map((i) => i.number).filter((n) => !merged.has(n)));
  open.splice(0, open.length, ...open.filter((i) => !merged.has(i.number) && !SKIP.has(i.number)));
  const ready = open.filter((i) => {
    const blockers = [...i.body.matchAll(/Blocked by\s+((?:#\d+[\s,and]*)+)/gi)]
      .flatMap((m) => [...m[1].matchAll(/#(\d+)/g)].map((n) => Number(n[1])));
    return blockers.every((b) => !openNumbers.has(b));
  });
  // Highest priority first, then lowest number. The loop reads the labels again before each iteration.
  ready.sort((a, b) => priority(a) - priority(b) || a.number - b.number);
  if (open.length && !ready.length) console.log("All open issues are blocked.");
  // The issue list can be stale just after a merge. Check the state of the issue again.
  return ready.find((i) => sh("gh", ["issue", "view", String(i.number), "--json", "state", "--jq", ".state"]) === "OPEN");
}

// Collect the last lines of the log of each failed CI job of a PR.
function failedCiLog(url: string): string {
  const sha = spawnSync("gh", ["pr", "view", url, "--json", "headRefOid", "--jq", ".headRefOid"], { encoding: "utf8" }).stdout.trim();
  const ids = spawnSync("gh", ["run", "list", "--commit", sha, "--json", "databaseId,conclusion", "--jq", '.[] | select(.conclusion == "failure") | .databaseId'], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
  return ids.map((id) => {
    const raw = spawnSync("gh", ["run", "view", id, "--log-failed"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout;
    const clean = raw.replace(/\x1b\[[0-9;]*m/g, "").split("\n");
    return `## CI run ${id}\n${clean.slice(-150).join("\n")}`;
  }).join("\n");
}

const CHECKS = [
  ["npm ci", "npm ci --no-audit --no-fund"],
  ["typecheck", "npm run typecheck"],
  ["test", "npm test"],
  ["crap (CRAP < 6)", "npm run crap"],
];

async function runChecks(sandbox: sandcastle.Sandbox): Promise<{ ok: boolean; log: string }> {
  let log = "";
  for (const [name, cmd] of CHECKS) {
    const r = await sandbox.exec(`(${cmd}) > /tmp/check.log 2>&1; rc=$?; tail -n 150 /tmp/check.log; exit $rc`);
    log += `## ${name} (\`${cmd}\`)\n${r.stdout}\n`;
    if (r.exitCode !== 0) return { ok: false, log };
  }
  return { ok: true, log };
}

if (process.env.DRY_RUN) {
  const issue = nextIssue(new Set());
  console.log(issue ? `Next issue: #${issue.number} ${issue.title}` : "No ready issue.");
  process.exit(0);
}


// The token cannot read check rollups. Read the GitHub Actions runs for the PR head commit.
function ciState(url: string): "none" | "pending" | "success" | "failure" {
  const sha = spawnSync("gh", ["pr", "view", url, "--json", "headRefOid", "--jq", ".headRefOid"], { encoding: "utf8" }).stdout.trim();
  const out = spawnSync("gh", ["run", "list", "--commit", sha, "--json", "status,conclusion"], { encoding: "utf8" }).stdout;
  let runs: { status: string; conclusion: string }[] = [];
  try { runs = JSON.parse(out || "[]"); } catch { return "pending"; }
  if (runs.length === 0) return "none";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  return runs.every((r) => r.conclusion === "success" || r.conclusion === "skipped") ? "success" : "failure";
}
async function waitCi(url: string): Promise<boolean> {
  for (let i = 0; i < 120; i++) {
    const st = ciState(url);
    if (st === "success") return true;
    if (st === "failure") return false;
    await sleepUntil(Date.now() + 15_000);
  }
  return false;
}

// The commit messages for the PR body. Without a Verification section, add a visible note (rule 8).
function prLog(branch: string): string {
  const log = sh("git", ["log", "--reverse", "--format=%B", `main..${branch}`]);
  return log.includes("## Verification") ? log
    : `${log}\n\n## Verification\n\n**Missing: no commit has a Verification section with a command and its real output. A reviewer must add it before the merge.**`;
}

const merged = new Set<number>();
console.log(`Agent chain: ${LABELS.join(" -> ")}. Reviewer: ${REVIEW_MODEL}.`);
saveStatus();

for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
  sh("git", ["checkout", "main"]);
  sh("git", ["pull", "--rebase", "origin", "main"]);
  let issue = nextIssue(merged);
  if (!issue) {
    // The issue list can be stale just after a merge. Wait and try again one time.
    await sleepUntil(Date.now() + 30_000);
    issue = nextIssue(merged);
  }
  if (issue && merged.has(issue.number)) { console.log(`Issue #${issue.number} is already merged. Stopping.`); break; }
  if (!issue) { console.log("No ready issue. Stopping."); break; }
  console.log(`\n=== Iteration ${iteration}/${MAX_ITERATIONS}: issue #${issue.number} ${issue.title} ===\n`);
  currentIssue = issue.number;

  // Resume an open PR for this issue (for example after CI failed in an earlier run).
  const existing = JSON.parse(sh("gh", ["pr", "list", "--state", "open", "--json", "url,headRefName"]))
    .find((p: { headRefName: string }) => p.headRefName.startsWith(`sandcastle/issue-${issue.number}-`));
  const branch: string = existing?.headRefName ?? `sandcastle/issue-${issue.number}-${Date.now()}`;
  const args = { ISSUE: String(issue.number), BRANCH: branch };
  let passed = Boolean(existing);
  if (existing) {
    console.log(`Resume the open PR ${existing.url}.`);
    spawnSync("git", ["fetch", "origin", branch]);
    spawnSync("git", ["branch", "-f", branch, `origin/${branch}`]);
  } else {
  const sandbox = await sandcastle.createSandbox({ branch, sandbox: podman(), hooks });
  try {
    const implement = await runPhase(sandbox, {
      name: "implementer", maxIterations: 1,
      promptFile: "./.sandcastle/implement-prompt.md", promptArgs: args,
    });
    if (!implement.commits.length) { console.log(`No commits for #${issue.number}. Stopping.`); break; }

    await runPhase(sandbox, {
      name: "reviewer", maxIterations: 1,
      promptFile: "./.sandcastle/review-prompt.md", promptArgs: args,
    });

    for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      const result = await runChecks(sandbox);
      if (result.ok) { passed = true; break; }
      console.log(`Checks failed for #${issue.number} (attempt ${attempt}).`);
      if (attempt === MAX_FIX_ATTEMPTS) break;
      await runPhase(sandbox, {
        name: `fixer-${attempt + 1}`, maxIterations: 1,
        promptFile: "./.sandcastle/fix-prompt.md",
        promptArgs: { ...args, CHECK_LOG: result.log.slice(-12000) }, checkLog: result.log.slice(-12000),
      });
    }
  } finally {
    await sandbox.close();
  }
  }

  if (!passed) {
    console.log(`Issue #${issue.number} cannot pass the checks. Stopping the loop.`);
    sh("gh", ["issue", "comment", String(issue.number), "--body",
      `Sandcastle stopped. The checks failed after ${MAX_FIX_ATTEMPTS} fix attempts. Branch: \`${branch}\`.`]);
    sh("git", ["push", "-f", "origin", branch]);
    process.exitCode = 1;
    break;
  }

  if (!existing) sh("git", ["push", "-f", "origin", branch]);
  const url: string = existing ? existing.url : sh("gh", ["pr", "create", "--base", "main", "--head", branch,
    "--title", issue.title,
    "--body", `This PR implements #${issue.number}.\n\n${prLog(branch)}\n\nThe local checks pass at the workspace root: \`npm ci\`, \`npm run typecheck\`, \`npm test\` and \`npm run crap\`.\n\nCloses #${issue.number}`]);
  console.log(`PR: ${url}`);
  // Merge only when all GitHub Actions checks on the PR pass.
  let hasChecks = false;
  for (let wait = 0; wait < 12 && !hasChecks; wait++) {
    await sleepUntil(Date.now() + 15_000);
    hasChecks = ciState(url) !== "none";
  }
  if (!hasChecks) {
    console.log(`No CI checks started for ${url}. Do not merge. Stopping the loop.`);
    process.exitCode = 1;
    break;
  }
  // main can require the CI checks on an up-to-date branch. Update the branch and retry.
  let mergedOk = false;
  for (let attempt = 0; attempt <= MAX_FIX_ATTEMPTS && !mergedOk; attempt++) {
    spawnSync("gh", ["pr", "update-branch", url], { stdio: "inherit" });
    await sleepUntil(Date.now() + 20_000);
    if (await waitCi(url)) {
      mergedOk = spawnSync("gh", ["pr", "merge", url, "--squash", "--delete-branch"], { stdio: "inherit" }).status === 0;
      continue;
    }
    if (attempt === MAX_FIX_ATTEMPTS) break;
    // CI failed. Give the CI log to the fixer agent, push the fix, and wait for CI again.
    console.log(`CI failed for ${url}. Run the fixer (attempt ${attempt + 1}).`);
    spawnSync("git", ["fetch", "origin", branch]);
    spawnSync("git", ["branch", "-f", branch, `origin/${branch}`]);
    const fixBox = await sandcastle.createSandbox({ branch, sandbox: podman(), hooks });
    try {
      await runPhase(fixBox, {
        name: `ci-fixer-${attempt + 1}`, maxIterations: 1,
        promptFile: "./.sandcastle/fix-prompt.md",
        promptArgs: { ...args, CHECK_LOG: failedCiLog(url).slice(-12000) },
      });
    } finally {
      await fixBox.close();
    }
    sh("git", ["push", "-f", "origin", branch]);
  }
  if (!mergedOk) {
    console.log(`CI failed or the merge failed for ${url}. Do not merge. Stopping the loop.`);
    process.exitCode = 1;
    break;
  }
  const state = sh("gh", ["issue", "view", String(issue.number), "--json", "state", "--jq", ".state"]);
  if (state !== "CLOSED") sh("gh", ["issue", "close", String(issue.number), "--comment", `Merged in ${url}.`]);
  console.log(`Merged ${url}. Issue #${issue.number} is closed.`);
  spawnSync("git", ["branch", "-D", branch]);
  merged.add(issue.number);
}

console.log("\nAll done.");
