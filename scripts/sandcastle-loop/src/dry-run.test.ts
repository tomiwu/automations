import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { hermeticEnv, type Hermetic } from "./test-env.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dirs: string[] = [];

// A fake gh on PATH. It prints fixed JSON and never uses the network.
function stubDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "loop-stub-"));
  dirs.push(dir);
  const issues = [
    { number: 7, title: "Low one", body: "", labels: [{ name: "Sandcastle" }, { name: "priority: low" }] },
    { number: 8, title: "High one", body: "", labels: [{ name: "Sandcastle" }, { name: "priority: high" }] },
    { number: 9, title: "Blocked high", body: "Blocked by #7", labels: [{ name: "Sandcastle" }, { name: "priority: critical" }] },
  ];
  writeFileSync(join(dir, "issues.json"), JSON.stringify(issues));
  const script = `#!/bin/sh
case "$2" in
  list) cat "${dir}/issues.json" ;;
  view) echo OPEN ;;
  *) exit 1 ;;
esac
`;
  writeFileSync(join(dir, "gh"), script);
  chmodSync(join(dir, "gh"), 0o755);
  return dir;
}

function dryRun(extra: Record<string, string>): string {
  const stub = stubDir();
  const result = spawnSync(process.execPath, ["--import", "tsx", join(root, "main.mts")], {
    encoding: "utf8",
    cwd: root,
    env: { ...hermetic(stub), DRY_RUN: "1", LOOP_REPO: "example-owner/example-repo", ...extra },
  });
  return result.stdout + result.stderr;
}

const boxes: Hermetic[] = [];

/** The stub gh first, then real node and git, then the system directories. Nothing else of the machine. */
function hermetic(stub: string): Record<string, string> {
  const box = hermeticEnv({}, { real: ["node", "git"] });
  boxes.push(box);
  return { ...box.env, PATH: `${stub}:${box.env.PATH}` };
}

afterEach(() => {
  boxes.splice(0).forEach((box) => box.cleanup());
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("DRY_RUN=1", () => {
  it("prints the next issue from a fake gh", () => {
    expect(dryRun({})).toContain("Next issue: #8 High one");
  });

  it("follows LOOP_SORT", () => {
    expect(dryRun({ LOOP_SORT: "-number" })).toContain("Next issue: #8 High one");
    expect(dryRun({ LOOP_SORT: "number" })).toContain("Next issue: #7 Low one");
  });
});
