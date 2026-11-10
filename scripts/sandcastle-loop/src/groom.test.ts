import { describe, expect, it } from "vitest";
import { filterProposals, idleStep, MAX_PROPOSALS, parseProposals, type IdleStep, type Proposal } from "./groom.ts";

const p = (title: string, body = "## Problem\nExample.\n\n## Acceptance criteria\n- [ ] Example") => ({ title, body });
const block = (items: Proposal[]) => `thinking...\n<proposals>${JSON.stringify(items)}</proposals>\n`;

// A fake gh: it records each call and answers the issue list with the open titles.
function fakeGh(openTitles: string[]) {
  const calls: string[][] = [];
  const exec = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (args[0] === "issue" && args[1] === "list") return JSON.stringify(openTitles.map((title) => ({ title })));
    if (args[0] === "issue" && args[1] === "create") return `https://github.com/example-owner/example-repo/issues/${100 + calls.length}`;
    return "";
  };
  return { exec, calls };
}

function step(gh: ReturnType<typeof fakeGh>, agentOutput: string, extra: Partial<IdleStep> = {}) {
  const slept: number[] = [];
  const logs: string[] = [];
  const groomed: string[][] = [];
  const s: IdleStep = {
    exec: gh.exec, repo: "example-owner/example-repo", triageLabel: "needs-triage",
    groom: async (titles) => (groomed.push(titles), agentOutput),
    denylist: [], secretValues: [], sleep: async (ms) => void slept.push(ms), idleMs: 30 * 60_000, log: (m) => logs.push(m), ...extra,
  };
  return { s, slept, logs, groomed };
}

describe("idleStep", () => {
  it("on an empty queue opens at most 3 issues with needs-triage only, then sleeps and does not exit", async () => {
    const gh = fakeGh(["Existing issue"]);
    const { s, slept, groomed } = step(gh, block([p("One"), p("Two"), p("Three"), p("Four")]));
    const urls = await idleStep(s);
    const creates = gh.calls.filter((c) => c[1] === "issue" && c[2] === "create");
    expect(creates).toHaveLength(3);
    for (const call of creates) {
      expect(call[call.indexOf("--label") + 1]).toBe("needs-triage");
      expect(call.filter((a) => a === "--label")).toHaveLength(1);
      expect(call).not.toContain("Sandcastle");
    }
    expect(urls).toHaveLength(3);
    expect(groomed).toEqual([["Existing issue"]]);
    expect(slept).toEqual([30 * 60_000]);
  });

  it("does not create a proposal with the title of an open issue", async () => {
    const gh = fakeGh(["Add retry to the export"]);
    const { s, logs } = step(gh, block([p("  add retry to the EXPORT "), p("New thing")]));
    await idleStep(s);
    const titles = gh.calls.filter((c) => c[1] === "issue" && c[2] === "create").map((c) => c[c.indexOf("--title") + 1]);
    expect(titles).toEqual(["New thing"]);
    expect(logs.some((l) => l.includes("duplicate of an open issue"))).toBe(true);
  });

  it("creates nothing and still sleeps when the agent fails or proposes nothing", async () => {
    const gh = fakeGh([]);
    const failing = step(gh, "", { groom: async () => Promise.reject(new Error("agent down")) });
    expect(await idleStep(failing.s)).toEqual([]);
    expect(failing.logs).toContain("GROOM failed: Error: agent down");
    expect(failing.slept).toHaveLength(1);
    const empty = step(gh, "<proposals>[]</proposals>");
    expect(await idleStep(empty.s)).toEqual([]);
    expect(gh.calls.some((c) => c[2] === "create" || c[1] === "label")).toBe(false);
  });
});

describe("filterProposals", () => {
  it("drops deny-list hits, secrets and token shapes, and duplicates inside the batch", () => {
    const logs: string[] = [];
    const kept = filterProposals(
      [p("Fix Example School export"), p("Rotate", "use sk-ant-FAKE0123456789abcdef"), p("Leak", "value fake-secret-value-1"), p("Good"), p("good")],
      { openTitles: [], denylist: ["example school"], secretValues: ["fake-secret-value-1"], log: (m) => logs.push(m) },
    );
    expect(kept.map((k) => k.title)).toEqual(["Good"]);
    expect(logs.map((l) => l.split(": ").at(-1))).toEqual(["personal data (deny-list)", "secret or token", "secret or token", "duplicate of an open issue"]);
  });

  it("keeps at most 3", () => {
    const kept = filterProposals([p("a"), p("b"), p("c"), p("d")], { openTitles: [], denylist: [], secretValues: [] });
    expect(kept).toHaveLength(MAX_PROPOSALS);
  });
});

describe("parseProposals", () => {
  it("reads the last block, also when it is escaped in stream JSON", () => {
    const escaped = JSON.stringify({ text: `<proposals>${JSON.stringify([p("Escaped")])}</proposals>` });
    expect(parseProposals(escaped).map((x) => x.title)).toEqual(["Escaped"]);
    expect(parseProposals(`${block([p("Old")])}${block([p("New")])}`).map((x) => x.title)).toEqual(["New"]);
  });

  it("ignores bad blocks and bad items", () => {
    expect(parseProposals("no block")).toEqual([]);
    expect(parseProposals("<proposals>not json</proposals>")).toEqual([]);
    expect(parseProposals('<proposals>{"title":"x"}</proposals>')).toEqual([]);
    expect(parseProposals('<proposals>[{"title":""},{"title":"ok","body":"b"},{"body":"x"}]</proposals>')).toEqual([{ title: "ok", body: "b" }]);
  });
});
