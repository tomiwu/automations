import { describe, expect, it } from "vitest";
import { blockersOf, parseSort, priorityRank, readyIssues, sortIssues, type Issue } from "./queue.ts";

function issue(number: number, labels: string[] = [], body = ""): Issue {
  return { number, title: `Issue ${number}`, body, labels: labels.map((name) => ({ name })) };
}
const numbers = (issues: Issue[]) => issues.map((i) => i.number);

describe("priorityRank", () => {
  it("ranks the priority labels and treats no label as medium", () => {
    expect(priorityRank(issue(1, ["priority: critical"]))).toBe(0);
    expect(priorityRank(issue(1, ["priority:high"]))).toBe(1);
    expect(priorityRank(issue(1))).toBe(2);
    expect(priorityRank(issue(1, ["Sandcastle", "priority: low"]))).toBe(3);
  });

  it("uses the highest priority label", () => {
    expect(priorityRank(issue(1, ["priority: low", "priority: high"]))).toBe(1);
  });
});

describe("sortIssues", () => {
  const list = [issue(5, ["priority: low"]), issue(2), issue(9, ["priority: critical"]), issue(3, ["priority: high"]), issue(1, ["priority: medium"])];

  it("sorts by priority, then the lowest number", () => {
    expect(numbers(sortIssues(list, parseSort("priority,number")))).toEqual([9, 3, 1, 2, 5]);
  });

  it("sorts by number only", () => {
    expect(numbers(sortIssues(list, parseSort("number")))).toEqual([1, 2, 3, 5, 9]);
  });

  it("sorts by the highest number first", () => {
    expect(numbers(sortIssues(list, parseSort("-number")))).toEqual([9, 5, 3, 2, 1]);
  });

  it("puts issues with a named label first", () => {
    const sorted = sortIssues([issue(1), issue(2, ["Urgent"]), issue(3)], parseSort("label:urgent,number"));
    expect(numbers(sorted)).toEqual([2, 1, 3]);
  });

  it("breaks ties by number when the keys have no number", () => {
    expect(numbers(sortIssues([issue(4), issue(2)], parseSort("priority")))).toEqual([2, 4]);
  });

  it("does not change the input list", () => {
    sortIssues(list, parseSort("-number"));
    expect(numbers(list)).toEqual([5, 2, 9, 3, 1]);
  });
});

describe("parseSort", () => {
  it("rejects an unknown key", () => {
    expect(() => parseSort("priority,age")).toThrow("Unknown LOOP_SORT key: age");
  });

  it("rejects an empty label key", () => {
    expect(() => parseSort("label:")).toThrow();
  });
});

describe("blockersOf", () => {
  it("reads one or many blockers", () => {
    expect(blockersOf(issue(1, [], "Blocked by #4"))).toEqual([4]);
    expect(blockersOf(issue(1, [], "blocked by #4, #5 and #6\nText #7"))).toEqual([4, 5, 6]);
    expect(blockersOf(issue(1, [], "No blocker. See #8."))).toEqual([]);
  });
});

describe("readyIssues", () => {
  const keys = parseSort("priority,number");

  it("skips an issue with an open blocker", () => {
    const open = [issue(1, [], "Blocked by #2"), issue(2, ["priority: low"])];
    expect(numbers(readyIssues(open, keys, new Set(), new Set()))).toEqual([2]);
  });

  it("keeps an issue when the blocker is not open", () => {
    expect(numbers(readyIssues([issue(1, [], "Blocked by #99")], keys, new Set(), new Set()))).toEqual([1]);
  });

  it("treats a merged blocker as done", () => {
    const open = [issue(1, [], "Blocked by #2"), issue(2)];
    expect(numbers(readyIssues(open, keys, new Set([2]), new Set()))).toEqual([1]);
  });

  it("drops skipped issues", () => {
    expect(numbers(readyIssues([issue(1), issue(2)], keys, new Set(), new Set([1])))).toEqual([2]);
  });
});
