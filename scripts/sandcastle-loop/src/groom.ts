// The idle step of the loop: when no issue is ready, a read-only groomer proposes at most 3 small issues.
// The host opens them with the triage label (not the loop label), so the owner accepts them first.
import { buildRedactor } from "./redact.ts";
import type { Exec } from "./issues.ts";

export interface Proposal {
  title: string;
  body: string;
}

export const MAX_PROPOSALS = 3;
const MAX_TITLE = 120;

function unescapeJson(text: string): string {
  try {
    return JSON.parse(`"${text}"`) as string;
  } catch {
    return text;
  }
}

function isProposal(value: unknown): value is Proposal {
  const p = value as Partial<Proposal> | null;
  return typeof p?.title === "string" && p.title.trim() !== "" && typeof p.body === "string";
}

/**
 * Reads the proposals of the last `<proposals>[...]</proposals>` block of the agent output. The block can be
 * escaped inside the stream JSON of the agent CLI. Bad or missing blocks give no proposal.
 */
export function parseProposals(stdout: string): Proposal[] {
  const blocks = [...stdout.matchAll(/<proposals>([\s\S]*?)<\/proposals>/g)];
  const raw = blocks.at(-1)?.[1];
  if (raw === undefined) return [];
  for (const candidate of [raw, unescapeJson(raw)]) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) return parsed.filter(isProposal).map((p) => ({ title: p.title.trim().slice(0, MAX_TITLE), body: p.body }));
    } catch {
      // Try the unescaped text.
    }
  }
  return [];
}

const normal = (title: string): string => title.trim().replace(/\s+/g, " ").toLowerCase();

export interface FilterOptions {
  openTitles: readonly string[];
  /** Personal strings (same deny-list as CI). A proposal with one of them is dropped. */
  denylist: readonly string[];
  /** Known secret values. A proposal with a secret value or a token shape is dropped. */
  secretValues: readonly string[];
  log?: (message: string) => void;
}

function rejection(proposal: Proposal, options: FilterOptions, seen: Set<string>): string | undefined {
  const text = `${proposal.title}\n${proposal.body}`;
  if (seen.has(normal(proposal.title))) return "duplicate of an open issue";
  const lower = text.toLowerCase();
  if (options.denylist.some((entry) => entry && lower.includes(entry.toLowerCase()))) return "personal data (deny-list)";
  if (buildRedactor([...options.secretValues])(text) !== text) return "secret or token";
  return undefined;
}

/** Drops duplicates of open issues (and of each other), deny-list hits and secrets. Keeps at most 3. */
export function filterProposals(proposals: readonly Proposal[], options: FilterOptions): Proposal[] {
  const seen = new Set(options.openTitles.map(normal));
  const kept: Proposal[] = [];
  for (const proposal of proposals) {
    const reason = rejection(proposal, options, seen);
    if (reason) {
      options.log?.(`GROOM skip "${proposal.title.slice(0, 60)}": ${reason}`);
      continue;
    }
    seen.add(normal(proposal.title));
    kept.push(proposal);
  }
  return kept.slice(0, MAX_PROPOSALS);
}

const repoArgs = (repo: string | undefined): string[] => (repo ? ["--repo", repo] : []);

/** The titles of all open issues, with any label. */
export function openIssueTitles(exec: Exec, repo: string | undefined): string[] {
  const out = exec("gh", ["issue", "list", ...repoArgs(repo), "--state", "open", "--limit", "500", "--json", "title"]);
  return (JSON.parse(out) as { title: string }[]).map((issue) => issue.title);
}

/** Opens each proposal as an issue with the triage label only. Returns the URLs. */
export function createProposals(exec: Exec, repo: string | undefined, label: string, proposals: readonly Proposal[]): string[] {
  if (!proposals.length) return [];
  exec("gh", ["label", "create", label, ...repoArgs(repo), "--force", "--color", "fbca04", "--description", "Proposed by the loop groomer. Accept it before the loop works on it."]);
  return proposals.map((p) =>
    exec("gh", ["issue", "create", ...repoArgs(repo), "--title", p.title, "--body", `${p.body}\n\n_Proposed by the loop groomer. Add the loop label to accept it._`, "--label", label]));
}

export interface IdleStep {
  exec: Exec;
  repo: string | undefined;
  triageLabel: string;
  /** Runs the read-only groomer agent with the open issue titles and returns its output. */
  groom: (openTitles: string[]) => Promise<string>;
  denylist: readonly string[];
  secretValues: readonly string[];
  sleep: (ms: number) => Promise<void>;
  idleMs: number;
  log: (message: string) => void;
}

/** One idle step: groom, open at most 3 triage issues, then sleep. It never exits the loop. */
export async function idleStep(step: IdleStep): Promise<string[]> {
  let urls: string[] = [];
  try {
    const openTitles = openIssueTitles(step.exec, step.repo);
    const proposals = filterProposals(parseProposals(await step.groom(openTitles)), { ...step, openTitles });
    urls = createProposals(step.exec, step.repo, step.triageLabel, proposals);
    step.log(`GROOM opened ${urls.length} issue(s) with the label ${step.triageLabel}${urls.length ? `: ${urls.join(" ")}` : ""}`);
  } catch (error) {
    step.log(`GROOM failed: ${`${error}`.slice(0, 200)}`);
  }
  step.log(`IDLE: sleep ${Math.round(step.idleMs / 60000)} min, then check the queue again.`);
  await step.sleep(step.idleMs);
  return urls;
}
