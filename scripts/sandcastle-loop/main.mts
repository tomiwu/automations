// Shared Sandcastle loop: implement -> review -> check -> PR -> CI -> merge.
//
// For each iteration, the host does these steps:
//   1. Select the next open issue with the loop label that has no open "Blocked by #N" issue.
//      LOOP_SORT sets the order. The default is priority labels first, then the lowest number.
//   2. Read the issue text on the host and create a sandbox on the branch "sandcastle/issue-<N>".
//   3. Run the implementer agent, then the reviewer agent.
//   4. Run LOOP_CHECKS in the sandbox. If a check fails, run the fixer agent (MAX_FIX_ATTEMPTS).
//   5. Push the branch, open a PR, wait for CI, squash-merge, close the issue.
// The loop stops when no issue is ready, or when an issue cannot pass.
// See README.md in this directory for the environment variables.
//
// Usage:
//   LOOP_REPO=owner/name npx tsx scripts/sandcastle-loop/main.mts
//   DRY_RUN=1 npx tsx scripts/sandcastle-loop/main.mts     (print the next issue, run no agent)

import * as sandcastle from "@ai-hero/sandcastle";
import { podman } from "@ai-hero/sandcastle/sandboxes/podman";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type ModelSpec } from "./src/config.ts";
import { issueText, nextIssue, type Exec } from "./src/issues.ts";
import { ModelOrder, withFallback } from "./src/models.ts";

const config = loadConfig(process.env, process.cwd(), join(dirname(fileURLToPath(import.meta.url)), "prompts"));
const repoFlags = config.repo ? ["--repo", config.repo] : [];

const sh: Exec = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();

function quiet(cmd: string, args: string[]): string {
  return spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).stdout.trim();
}

const queueOptions = (done: Set<number>) =>
  ({ repo: config.repo, label: config.label, sort: config.sort, done, skip: config.skip });

if (process.env.DRY_RUN) {
  const issue = nextIssue(sh, queueOptions(new Set()), console.log);
  console.log(issue ? `Next issue: #${issue.number} ${issue.title}` : "No ready issue.");
  process.exit(0);
}

const order = new ModelOrder(config.models);
const hooks = { sandbox: { onSandboxReady: [{ command: "npm ci --no-audit --no-fund || true" }] } };
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

async function runChecks(sandbox: sandcastle.Sandbox): Promise<{ ok: boolean; log: string }> {
  const r = await sandbox.exec(`(${config.checks}) > /tmp/check.log 2>&1; rc=$?; tail -n 150 /tmp/check.log; exit $rc`);
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

// Collect the last lines of the log of each failed CI job of a PR.
function failedCiLog(url: string): string {
  const jq = '.[] | select(.conclusion == "failure") | .databaseId';
  const ids = quiet("gh", ["run", "list", ...repoFlags, "--commit", headSha(url), "--json", "databaseId,conclusion", "--jq", jq]).split("\n").filter(Boolean);
  return ids.map((id) => {
    const raw = quiet("gh", ["run", "view", id, ...repoFlags, "--log-failed"]);
    return `## CI run ${id}\n${raw.replace(/\x1b\[[0-9;]*m/g, "").split("\n").slice(-150).join("\n")}`;
  }).join("\n");
}

function prompt(name: string): string {
  return join(config.promptDir, name);
}

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
  if (!issue) { console.log("No ready issue. Stopping."); break; }
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
    spawnSync("git", ["fetch", "origin", branch]);
    spawnSync("git", ["branch", "-f", branch, `origin/${branch}`]);
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
    spawnSync("gh", ["pr", "update-branch", url], { stdio: "inherit" });
    await sleep(20_000);
    if (await waitCi(url)) {
      mergedOk = spawnSync("gh", ["pr", "merge", url, "--squash", "--delete-branch"], { stdio: "inherit" }).status === 0;
      continue;
    }
    if (attempt === config.maxFixAttempts) break;
    // CI failed. Give the CI log to the fixer agent, push the fix, and wait for CI again.
    console.log(`CI failed for ${url}. Run the fixer (attempt ${attempt + 1}).`);
    spawnSync("git", ["fetch", "origin", branch]);
    spawnSync("git", ["branch", "-f", branch, `origin/${branch}`]);
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
  spawnSync("git", ["branch", "-D", branch]);
  merged.add(issue.number);
}

console.log("\nAll done.");
