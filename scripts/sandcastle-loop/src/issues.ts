import { readyIssues, type Issue, type SortKey } from "./queue.ts";

export type Exec = (cmd: string, args: string[]) => string;

export interface QueueOptions {
  repo: string | undefined;
  label: string;
  sort: SortKey[];
  done: Set<number>;
  skip: Set<number>;
}

function repoArgs(repo: string | undefined): string[] {
  return repo ? ["--repo", repo] : [];
}

export function listOpen(exec: Exec, repo: string | undefined, label: string): Issue[] {
  const out = exec("gh", ["issue", "list", ...repoArgs(repo), "--state", "open", "--label", label,
    "--limit", "100", "--json", "number,title,body,labels"]);
  return JSON.parse(out) as Issue[];
}

function isOpen(exec: Exec, repo: string | undefined, issue: Issue): boolean {
  return exec("gh", ["issue", "view", String(issue.number), ...repoArgs(repo), "--json", "state", "--jq", ".state"]) === "OPEN";
}

// The next issue to work on. The issue list can be stale just after a merge, so the state is read again.
export function nextIssue(exec: Exec, options: QueueOptions, log: (message: string) => void = () => {}): Issue | undefined {
  const open = listOpen(exec, options.repo, options.label);
  const ready = readyIssues(open, options.sort, options.done, options.skip);
  if (open.length && !ready.length) log("All open issues are blocked.");
  return ready.find((i) => isOpen(exec, options.repo, i));
}

// The host reads the issue text. The sandbox token needs no access to the repository.
export function issueText(exec: Exec, repo: string | undefined, number: number): string {
  const out = exec("gh", ["issue", "view", String(number), ...repoArgs(repo), "--json", "number,title,body,comments"]);
  const issue = JSON.parse(out) as { number: number; title: string; body: string; comments: { body: string }[] };
  return JSON.stringify({ number: issue.number, title: issue.title, body: issue.body, comments: issue.comments.map((c) => c.body) });
}
