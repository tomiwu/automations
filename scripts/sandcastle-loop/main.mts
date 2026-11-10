// Shared Sandcastle loop: implement -> review -> check -> PR -> CI -> merge.
//
// For each iteration, the host does these steps:
//   1. Select the next open issue with the loop label that has no open "Blocked by #N" issue.
//      LOOP_SORT sets the order. The default is priority labels first, then the lowest number.
//   2. Read the issue text on the host and create a sandbox on the branch "sandcastle/issue-<N>".
//   3. Run the implementer agent, then the reviewer agent.
//   4. Run LOOP_CHECKS in the sandbox. If a check fails, run the fixer agent (MAX_FIX_ATTEMPTS).
//   5. Push the branch, open a PR, wait for CI, squash-merge, close the issue.
// Before iteration 1 the preflight doctor (doctor.sh) runs. When it fails, no agent starts.
// Host gh and git push/pull calls are retried (LOOP_RETRY_DELAYS), so one network error does not stop the loop.
// When no issue is ready (LOOP_IDLE=groom, the default), a read-only groomer proposes at most 3 issues with the
// triage label, the loop sleeps (LOOP_IDLE_MINUTES) and checks the queue again. LOOP_IDLE=stop stops instead.
// The loop stops when an issue cannot pass.
// See README.md in this directory for the environment variables.
//
// Usage:
//   LOOP_REPO=owner/name npx tsx scripts/sandcastle-loop/main.mts
//   DRY_RUN=1 npx tsx scripts/sandcastle-loop/main.mts     (print the next issue, run no agent)

import * as sandcastle from "@ai-hero/sandcastle";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type ModelSpec } from "./src/config.ts";
import { idleStep } from "./src/groom.ts";
import { issueText, nextIssue, type Exec } from "./src/issues.ts";
import { withLock } from "./src/lock.ts";
import { ModelOrder, withFallback } from "./src/models.ts";
import { preflight } from "./src/preflight.ts";
import { secretValuesFromEnv } from "./src/redact.ts";
import { retrySync, retryingExec } from "./src/retry.ts";

const config = loadConfig(process.env, process.cwd(), join(dirname(fileURLToPath(import.meta.url)), "prompts"));
const repoFlags = config.repo ? ["--repo", config.repo] : [];

// "gh" and "git" in this file are the host commands LOOP_GH and LOOP_GIT (wrappers are allowed).
const hostCommand = (cmd: string): string => (cmd === "gh" ? config.gh : cmd === "git" ? config.git : cmd);
const retry = { delaysMs: config.retryDelaysMs, log: console.log, transient: config.retryTransient };

// stderr is captured (and still printed), so the retry can tell a transient error from a permanent one.
const rawSh: Exec = (cmd, args) => {
  try {
    return execFileSync(hostCommand(cmd), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    process.stderr.write(String((error as { stderr?: unknown }).stderr ?? ""));
    throw error;
  }
};
const sh: Exec = retryingExec(rawSh, new Set(["gh", "git"]), retry);

// A read that may fail without a stop. It is retried; after the last attempt it gives the output it has.
function quiet(cmd: string, args: string[]): string {
  const once = () => {
    const r = spawnSync(hostCommand(cmd), args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 2).join(" ")} exited ${r.status}\n${r.stderr}`);
    return r.stdout.trim();
  };
  try {
    return retrySync(`${cmd} ${args.slice(0, 2).join(" ")}`, once, retry);
  } catch {
    return "";
  }
}

// A step that may fail (for example `gh pr update-branch`). It is retried; returns true on success.
function tryStep(cmd: string, args: string[]): boolean {
  try {
    retrySync(`${cmd} ${args.slice(0, 2).join(" ")}`, () => {
      const r = spawnSync(hostCommand(cmd), args, { encoding: "utf8", stdio: ["inherit", "inherit", "pipe"] });
      process.stderr.write(r.stderr ?? "");
      if (r.status !== 0) throw new Error(`${cmd} failed\n${r.stderr}`);
    }, retry);
    return true;
  } catch {
    return false;
  }
}

const queueOptions = (done: Set<number>) =>
  ({ repo: config.repo, label: config.label, sort: config.sort, done, skip: config.skip });

if (process.env.DRY_RUN) {
  const issue = nextIssue(sh, queueOptions(new Set()), console.log);
  console.log(issue ? `Next issue: #${issue.number} ${issue.title}` : "No ready issue.");
  process.exit(0);
}

const doctorOk = preflight(
  () => (config.doctor ? spawnSync("bash", [config.doctor], { stdio: "inherit", env: process.env }).status ?? 1 : 0),
  process.env.LOOP_DOCTOR_DONE === "1",
  console.log,
);
if (!doctorOk) process.exit(1);

const order = new ModelOrder(config.models);
// The hook has no ignore-failure suffix: a failed sandbox-ready hook stops the sandbox, so no agent works in a broken sandbox.
const hooks = config.sandboxReady ? { sandbox: { onSandboxReady: [{ command: config.sandboxReady }] } } : {};
const sandboxProvider = () => (config.image ? podman({ imageName: config.image }) : podman());

function agentFor(spec: ModelSpec) {
  return spec.provider === "claude" ? sandcastle.claudeCode(spec.model) : sandcastle.cursor(spec.model);
}

type RunOptions = Omit<Parameters<sandcastle.Sandbox["run"]>[0], "agent">;

// Run one agent phase. On a limit error, change to the next model of LOOP_MODELS.
function runPhase(sandbox: sandcastle.Sandbox, options: RunOptions, text: string) {
  const promptArgs = { ...options.promptArgs, ISSUE_TEXT: text };
  return withFallback(order, (spec) =>
    sandbox.run({ idleTimeoutSeconds: 1800, ...options, promptArgs, agent: agentFor(spec) }), console.log);
}

// LOOP_CHECKS_LOCK: a box-wide lock file, so only one heavy check runs at a time on the box.
async function runChecks(sandbox: sandcastle.Sandbox): Promise<{ ok: boolean; log: string }> {
  const r = await withLock(config.checksLock, () =>
    sandbox.exec(`(${config.checks}) > /tmp/check.log 2>&1; rc=$?; tail -n 150 /tmp/check.log; exit $rc`));
  return { ok: r.exitCode === 0, log: `## checks (\`${config.checks}\`)\n${r.stdout}\n` };
}

// The token cannot read check rollups. Read the GitHub Actions runs for the PR head commit.
function headSha(url: string): string {
  return quiet("gh", ["pr", "view", url, "--json", "headRefOid", "--jq", ".headRefOid"]);
}

function ciState(url: string): "none" | "pending" | "success" | "failure" {
  const out = quiet("gh", ["run", "list", ...repoFlags, "--commit", headSha(url), "--json", "status,conclusion"]);
  let runs: { status: string; conclusion: string }[] = [];
  try { runs = JSON.parse(out || "[]"); } catch { return "pending"; }
  if (runs.length === 0) return "none";
  if (runs.some((r) => r.status !== "completed")) return "pending";
  return runs.every((r) => r.conclusion === "success" || r.conclusion === "skipped") ? "success" : "failure";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitCi(url: string): Promise<boolean> {
  for (let i = 0; i < 120; i++) {
    const state = ciState(url);
    if (state === "success") return true;
    if (state === "failure") return false;
    await sleep(15_000);
  }
  return false;
}

function failedRunIds(url: string): string[] {
  const jq = '.[] | select(.conclusion == "failure") | .databaseId';
  return quiet("gh", ["run", "list", ...repoFlags, "--commit", headSha(url), "--json", "databaseId,conclusion", "--jq", jq]).split("\n").filter(Boolean);
}

// LOOP_CI_LOG_FILTER: an optional shell filter (stdin to stdout) that removes download noise from a CI log.
function filtered(log: string): string {
  if (!config.ciLogFilter) return log;
  const r = spawnSync("bash", ["-c", config.ciLogFilter], { input: log, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : log;
}

// Collect the last lines of the log of each failed CI job of a PR.
function failedCiLog(url: string): string {
  return failedRunIds(url).map((id) => {
    const raw = filtered(quiet("gh", ["run", "view", id, ...repoFlags, "--log-failed"]).replace(/\x1b\[[0-9;]*m/g, ""));
    return `## CI run ${id}\n${raw.split("\n").slice(-150).join("\n")}`;
  }).join("\n");
}

// A failed CI can be a network error. Re-run the failed jobs one time before the fixer runs (LOOP_CI_RERUN=0 turns it off).
async function rerunOnce(url: string): Promise<boolean> {
  if (!config.ciRerun) return false;
  const ids = failedRunIds(url);
  if (!ids.length) return false;
  console.log(`CI failed for ${url}. Re-run the failed jobs one time before the fixer.`);
  for (const id of ids) tryStep("gh", ["run", "rerun", id, ...repoFlags, "--failed"]);
  await sleep(20_000);
  return waitCi(url);
}

function prompt(name: string): string {
  return join(config.promptDir, name);
}

function lines(path: string | undefined): string[] {
  return path && existsSync(path) ? readFileSync(path, "utf8").split("\n").map((l) => l.trim()).filter(Boolean) : [];
}

function logTail(): string {
  const current = join(config.logDir, "current.log");
  return existsSync(current) ? readFileSync(current, "utf8").split("\n").slice(-80).join("\n") : "(no log)";
}

// The read-only groomer: one agent run in a throwaway sandbox. Its commits are never pushed.
async function groom(openTitles: string[]): Promise<string> {
  const branch = `sandcastle/groom-${Date.now()}`;
  const sandbox = await sandcastle.createSandbox({ branch, sandbox: sandboxProvider(), hooks });
  try {
    const result = await runPhase(sandbox, {
      name: "groomer", maxIterations: 1, promptFile: prompt("groom-prompt.md"),
      promptArgs: { OPEN_ISSUES: openTitles.map((t) => `- ${t}`).join("\n") || "(none)", LOG_TAIL: logTail() },
    }, "");
    return result.stdout;
  } finally {
    await sandbox.close();
    spawnSync(config.git, ["branch", "-D", branch]);
  }
}

const idle = () => idleStep({
  exec: sh, repo: config.repo, triageLabel: config.triageLabel, groom,
  denylist: lines(config.denylistFile), secretValues: secretValuesFromEnv(process.env),
  sleep: (ms) => sleep(ms).then(() => undefined), idleMs: config.idleMs, log: console.log,
});

const merged = new Set<number>();
console.log(`Models: ${config.models.map((m) => `${m.provider}:${m.model}`).join(", ")}`);

for (let iteration = 1; iteration <= config.maxIterations; iteration++) {
  sh("git", ["checkout", "main"]);
  sh("git", ["pull", "--rebase", "origin", "main"]);
  let issue = nextIssue(sh, queueOptions(merged), console.log);
  if (!issue) {
    // The issue list can be stale just after a merge. Wait and try again one time.
    await sleep(30_000);
    issue = nextIssue(sh, queueOptions(merged), console.log);
  }
  if (!issue && config.idle === "stop") { console.log("No ready issue. Stopping (LOOP_IDLE=stop)."); break; }
  if (!issue) {
    console.log("No ready issue. Groom, sleep and check again.");
    await idle();
    iteration--; // An idle step does not use an iteration.
    continue;
  }
  console.log(`\n=== Iteration ${iteration}/${config.maxIterations}: issue #${issue.number} ${issue.title} ===\n`);

  const text = issueText(sh, config.repo, issue.number);
  // Resume an open PR for this issue (for example after CI failed in an earlier run).
  const existing = JSON.parse(sh("gh", ["pr", "list", ...repoFlags, "--state", "open", "--json", "url,headRefName"]))
    .find((p: { headRefName: string }) => p.headRefName.startsWith(`sandcastle/issue-${issue.number}-`));
  const branch: string = existing?.headRefName ?? `sandcastle/issue-${issue.number}-${Date.now()}`;
  const args = { ISSUE: String(issue.number), BRANCH: branch };
  let passed = Boolean(existing);
  if (existing) {
    console.log(`Resume the open PR ${existing.url}.`);
    tryStep("git", ["fetch", "origin", branch]);
    spawnSync(config.git, ["branch", "-f", branch, `origin/${branch}`]);
  } else {
    const sandbox = await sandcastle.createSandbox({ branch, sandbox: sandboxProvider(), hooks });
    try {
      const implement = await runPhase(sandbox, {
        name: "implementer", maxIterations: 1, promptFile: prompt("implement-prompt.md"), promptArgs: args,
      }, text);
      if (!implement.commits.length) { console.log(`No commits for #${issue.number}. Stopping.`); break; }

      await runPhase(sandbox, {
        name: "reviewer", maxIterations: 1, promptFile: prompt("review-prompt.md"), promptArgs: args,
      }, text);

      for (let attempt = 0; attempt <= config.maxFixAttempts; attempt++) {
        const result = await runChecks(sandbox);
        if (result.ok) { passed = true; break; }
        console.log(`Checks failed for #${issue.number} (attempt ${attempt}).`);
        if (attempt === config.maxFixAttempts) break;
        await runPhase(sandbox, {
          name: `fixer-${attempt + 1}`, maxIterations: 1, promptFile: prompt("fix-prompt.md"),
          promptArgs: { ...args, CHECK_LOG: result.log.slice(-12000) },
        }, text);
      }
    } finally {
      await sandbox.close();
    }
  }

  if (!passed) {
    console.log(`Issue #${issue.number} cannot pass the checks. Stopping the loop.`);
    sh("gh", ["issue", "comment", String(issue.number), ...repoFlags, "--body",
      `Sandcastle stopped. The checks failed after ${config.maxFixAttempts} fix attempts. Branch: \`${branch}\`.`]);
    sh("git", ["push", "-f", "origin", branch]);
    process.exitCode = 1;
    break;
  }

  if (!existing) sh("git", ["push", "-f", "origin", branch]);
  const url: string = existing ? existing.url : sh("gh", ["pr", "create", ...repoFlags, "--base", "main", "--head", branch,
    "--title", issue.title,
    "--body", `This PR implements #${issue.number}.\n\n${sh("git", ["log", "--reverse", "--format=%B", `main..${branch}`])}\n\nThe local checks pass: \`${config.checks}\`.\n\nCloses #${issue.number}`]);
  console.log(`PR: ${url}`);
  // Merge only when all GitHub Actions checks on the PR pass.
  let hasChecks = false;
  for (let wait = 0; wait < 12 && !hasChecks; wait++) {
    await sleep(15_000);
    hasChecks = ciState(url) !== "none";
  }
  if (!hasChecks) {
    console.log(`No CI checks started for ${url}. Do not merge. Stopping the loop.`);
    process.exitCode = 1;
    break;
  }
  // main can require the CI checks on an up-to-date branch. Update the branch and retry.
  let mergedOk = false;
  for (let attempt = 0; attempt <= config.maxFixAttempts && !mergedOk; attempt++) {
    tryStep("gh", ["pr", "update-branch", url]);
    await sleep(20_000);
    if (await waitCi(url) || (attempt === 0 && await rerunOnce(url))) {
      mergedOk = tryStep("gh", ["pr", "merge", url, "--squash", "--delete-branch"]);
      continue;
    }
    if (attempt === config.maxFixAttempts) break;
    // CI failed. Give the CI log to the fixer agent, push the fix, and wait for CI again.
    console.log(`CI failed for ${url}. Run the fixer (attempt ${attempt + 1}).`);
    tryStep("git", ["fetch", "origin", branch]);
    spawnSync(config.git, ["branch", "-f", branch, `origin/${branch}`]);
    const fixBox = await sandcastle.createSandbox({ branch, sandbox: sandboxProvider(), hooks });
    try {
      await runPhase(fixBox, {
        name: `ci-fixer-${attempt + 1}`, maxIterations: 1, promptFile: prompt("fix-prompt.md"),
        promptArgs: { ...args, CHECK_LOG: failedCiLog(url).slice(-12000) },
      }, text);
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
  const state = sh("gh", ["issue", "view", String(issue.number), ...repoFlags, "--json", "state", "--jq", ".state"]);
  if (state !== "CLOSED") sh("gh", ["issue", "close", String(issue.number), ...repoFlags, "--comment", `Merged in ${url}.`]);
  console.log(`Merged ${url}. Issue #${issue.number} is closed.`);
  spawnSync(config.git, ["branch", "-D", branch]);
  merged.add(issue.number);
}

console.log("\nAll done.");
