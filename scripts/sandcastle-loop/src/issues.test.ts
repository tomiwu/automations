import { describe, expect, it } from "vitest";
import { issueText, nextIssue, type Exec } from "./issues.ts";
import { parseSort } from "./queue.ts";

const list = [
  { number: 3, title: "Third", body: "Blocked by #1", labels: [{ name: "Sandcastle" }] },
  { number: 1, title: "First", body: "", labels: [{ name: "Sandcastle" }, { name: "priority: low" }] },
  { number: 2, title: "Second", body: "", labels: [{ name: "Sandcastle" }, { name: "priority: high" }] },
];

function fakeGh(states: Record<number, string> = {}) {
  const calls: string[][] = [];
  const exec: Exec = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[1] === "list") return JSON.stringify(list);
    if (args[1] === "view" && args.includes("state")) return states[Number(args[2])] ?? "OPEN";
    return JSON.stringify({ number: 2, title: "Second", body: "Body", comments: [{ body: "Comment" }] });
  };
  return { exec, calls };
}
const options = { repo: "example-owner/example-repo", label: "Sandcastle", sort: parseSort("priority,number"), done: new Set<number>(), skip: new Set<number>() };

describe("nextIssue", () => {
  it("picks the first ready issue and passes the repo and label to gh", () => {
    const { exec, calls } = fakeGh();
    expect(nextIssue(exec, options)?.number).toBe(2);
    expect(calls[0]).toContain("example-owner/example-repo");
    expect(calls[0]).toContain("Sandcastle");
  });

  it("skips an issue that is closed already", () => {
    const { exec } = fakeGh({ 2: "CLOSED" });
    expect(nextIssue(exec, options)?.number).toBe(1);
  });

  it("uses the custom sort and no --repo without a repo", () => {
    const { exec, calls } = fakeGh();
    expect(nextIssue(exec, { ...options, repo: undefined, sort: parseSort("-number") })?.number).toBe(2);
    expect(calls[0]).not.toContain("--repo");
  });

  it("says when all issues are blocked", () => {
    const logs: string[] = [];
    const exec: Exec = () => JSON.stringify([
      { number: 1, title: "A", body: "Blocked by #2", labels: [] },
      { number: 2, title: "B", body: "Blocked by #1", labels: [] },
    ]);
    expect(nextIssue(exec, options, (m) => logs.push(m))).toBeUndefined();
    expect(logs).toEqual(["All open issues are blocked."]);
  });
});

describe("issueText", () => {
  it("returns the issue as JSON with the comment bodies", () => {
    const { exec } = fakeGh();
    expect(JSON.parse(issueText(exec, undefined, 2))).toEqual({ number: 2, title: "Second", body: "Body", comments: ["Comment"] });
  });
});
