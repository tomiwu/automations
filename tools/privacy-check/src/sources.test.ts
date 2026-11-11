import { describe, expect, it } from "vitest";
import { parseHistory, parsePatch } from "./sources.ts";

const patch = [
  "diff --git a/docs/a.md b/docs/a.md",
  "--- a/docs/a.md",
  "+++ b/docs/a.md",
  "@@ -3,0 +4,2 @@ heading",
  "+first added",
  "+second added",
  "@@ -10 +12 @@",
  "-removed",
  "+changed",
  "diff --git a/old.txt b/old.txt",
  "--- a/old.txt",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
  "diff --git a/package-lock.json b/package-lock.json",
  "--- a/package-lock.json",
  "+++ b/package-lock.json",
  "@@ -1 +1 @@",
  "+skipped",
].join("\n");

describe("parsePatch", () => {
  it("gives the added lines with path and line number", () => {
    expect(parsePatch(patch, "", [])).toEqual([
      { where: "docs/a.md", line: 4, text: "first added" },
      { where: "docs/a.md", line: 5, text: "second added" },
      { where: "docs/a.md", line: 12, text: "changed" },
      { where: "package-lock.json", line: 1, text: "skipped" },
    ]);
  });

  it("skips the paths of the allowlist and adds the prefix", () => {
    const records = parsePatch(patch, "commit abc:", ["package-lock.json", "docs/a.md"]);
    expect(records).toEqual([]);
    expect(parsePatch(patch, "commit abc:", ["package-lock.json"])[0]?.where).toBe("commit abc:docs/a.md");
  });
});

describe("parseHistory", () => {
  it("gives the metadata, the message and the added lines of each commit", () => {
    const log = `\u0001abc1234\u0002Author One <one@example.com>\nCommitter <two@example.com>\nSubject line\n\nBody line\n\u0003\n${patch}\n\u0001def5678\u0002A <a@example.com>\nC <c@example.com>\nSecond\n\u0003\n`;
    const records = parseHistory(log, ["package-lock.json"]);
    expect(records.slice(0, 3)).toEqual([
      { where: "commit abc1234:metadata", line: 1, text: "Author One <one@example.com>" },
      { where: "commit abc1234:metadata", line: 2, text: "Committer <two@example.com>" },
      { where: "commit abc1234:metadata", line: 3, text: "Subject line" },
    ]);
    expect(records).toContainEqual({ where: "commit abc1234:docs/a.md", line: 12, text: "changed" });
    expect(records).toContainEqual({ where: "commit def5678:metadata", line: 3, text: "Second" });
    expect(records.some((record) => record.where.endsWith("package-lock.json"))).toBe(false);
  });
});
