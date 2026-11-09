export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: { name: string }[];
}

export type SortKey = "priority" | "number" | "-number" | `label:${string}`;

export const DEFAULT_SORT = "priority,number";

const PRIORITY: Record<string, number> = {
  "priority: critical": 0,
  "priority: high": 1,
  "priority: medium": 2,
  "priority: low": 3,
};
const MEDIUM = 2;

export function parseSort(text: string): SortKey[] {
  const keys = text.split(",").map((k) => k.trim()).filter(Boolean);
  for (const key of keys) {
    if (!["priority", "number", "-number"].includes(key) && !/^label:.+/.test(key)) {
      throw new Error(`Unknown LOOP_SORT key: ${key}`);
    }
  }
  return keys as SortKey[];
}

// Rank from the "priority: *" labels. The highest priority label wins. No label means medium.
// The labels "priority:high" and "priority: high" are the same label.
export function priorityRank(issue: Issue): number {
  const ranks = issue.labels
    .map((l) => PRIORITY[l.name.replace(/^priority:\s*/i, "priority: ").toLowerCase()])
    .filter((v): v is number => v !== undefined);
  return ranks.length ? Math.min(...ranks) : MEDIUM;
}

function keyValue(issue: Issue, key: SortKey): number {
  if (key === "priority") return priorityRank(issue);
  if (key === "number") return issue.number;
  if (key === "-number") return -issue.number;
  const wanted = key.slice("label:".length).toLowerCase();
  return issue.labels.some((l) => l.name.toLowerCase() === wanted) ? 0 : 1;
}

export function sortIssues(issues: Issue[], keys: SortKey[]): Issue[] {
  const order = keys.includes("number") || keys.includes("-number") ? keys : [...keys, "number" as const];
  return [...issues].sort((a, b) => {
    for (const key of order) {
      const diff = keyValue(a, key) - keyValue(b, key);
      if (diff !== 0) return diff;
    }
    return 0;
  });
}

// Issue numbers named in "Blocked by #1, #2 and #3" phrases.
export function blockersOf(issue: Issue): number[] {
  return [...issue.body.matchAll(/Blocked by\s+((?:#\d+[\s,and]*)+)/gi)]
    .flatMap((m) => [...(m[1] ?? "").matchAll(/#(\d+)/g)].map((n) => Number(n[1])));
}

// Issues that have no open blocker, in the order of the sort keys.
// `done` holds issues that the loop merged already. `skip` holds issues to ignore.
export function readyIssues(open: Issue[], keys: SortKey[], done: Set<number>, skip: Set<number>): Issue[] {
  const live = open.filter((i) => !done.has(i.number));
  const openNumbers = new Set(live.map((i) => i.number));
  const ready = live.filter((i) => !skip.has(i.number) && blockersOf(i).every((b) => !openNumbers.has(b)));
  return sortIssues(ready, keys);
}
