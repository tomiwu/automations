import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { envDrift, envNamesInCode, envNamesInReadme, hidesFailure } from "./env-table.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string): string => readFileSync(path, "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => join(dir, name));
}

const codeFiles = [
  ...sourceFiles(join(root, "src")),
  join(root, "main.mts"),
  join(root, "..", "sandcastle-loop.sh"),
  join(root, "doctor.sh"),
  join(root, "build-image.sh"),
];

const README = [
  "# Loop",
  "## Environment",
  "",
  "| Variable | Default | Meaning |",
  "| --- | --- | --- |",
  "| `LOOP_REPO` | the current repo | owner/name |",
  "| `LOOP_GH`, `LOOP_GIT` | `gh`, `git` | wrappers |",
  "| `MAX_ITERATIONS` | `10` | not a LOOP_ name |",
  "",
  "Text after the table can say `LOOP_OTHER` without a row.",
  "## Next section",
  "| `LOOP_NOT_ENV` | a table in another section |",
].join("\n");

describe("envNamesInReadme", () => {
  it("reads the first cell of the rows of the Environment section only", () => {
    expect(envNamesInReadme(README)).toEqual(["LOOP_GH", "LOOP_GIT", "LOOP_REPO"]);
  });

  it("gives no names without an Environment section", () => {
    expect(envNamesInReadme("# Loop\n| `LOOP_REPO` | x |")).toEqual([]);
  });
});

describe("envNamesInCode", () => {
  it("collects each LOOP_ name one time, sorted", () => {
    const ts = 'const repo = process.env.LOOP_REPO;\nconst gh = env["LOOP_GH"] ?? "gh";';
    const sh = 'GIT="${LOOP_GIT:-git}"\necho "$LOOP_REPO"';
    expect(envNamesInCode([ts, sh])).toEqual(["LOOP_GH", "LOOP_GIT", "LOOP_REPO"]);
  });

  it("does not take a name prefix like LOOP_ alone", () => {
    expect(envNamesInCode(["names start with LOOP_ and ${LOOP_X}"])).toEqual(["LOOP_X"]);
  });
});

describe("envDrift", () => {
  const readmeNames = envNamesInReadme(README);

  it("finds no drift when both lists match", () => {
    const code = envNamesInCode(['process.env.LOOP_REPO; env.LOOP_GH; "${LOOP_GIT:-git}"']);
    expect(envDrift(code, readmeNames)).toEqual({ missingInReadme: [], missingInCode: [] });
  });

  it("fails when a fixture adds an env read without a README row", () => {
    const code = envNamesInCode(['process.env.LOOP_REPO; env.LOOP_GH; env.LOOP_GIT; process.env.LOOP_NEW_KNOB ?? "x"']);
    expect(envDrift(code, readmeNames)).toEqual({ missingInReadme: ["LOOP_NEW_KNOB"], missingInCode: [] });
  });

  it("fails when the README has a row that the code does not read", () => {
    const code = envNamesInCode(["process.env.LOOP_REPO; env.LOOP_GH"]);
    expect(envDrift(code, readmeNames)).toEqual({ missingInReadme: [], missingInCode: ["LOOP_GIT"] });
  });
});

describe("the loop on this branch", () => {
  it("reads every LOOP_ name that the README env table has, and no other", () => {
    const code = envNamesInCode(codeFiles.map(read));
    const readme = envNamesInReadme(read(join(root, "README.md")));
    expect(code.length).toBeGreaterThan(10);
    expect(envDrift(code, readme)).toEqual({ missingInReadme: [], missingInCode: [] });
  });

  it("has no `|| true` in main.mts and src/*.ts", () => {
    const files = [join(root, "main.mts"), ...sourceFiles(join(root, "src"))];
    expect(files.filter((file) => hidesFailure(read(file)))).toEqual([]);
  });
});

describe("hidesFailure", () => {
  it("finds the pattern with or without spaces", () => {
    expect(hidesFailure("npm ci || true")).toBe(true);
    expect(hidesFailure("npm ci ||true")).toBe(true);
    expect(hidesFailure("npm ci || truex")).toBe(false);
    expect(hidesFailure("npm ci && npm test")).toBe(false);
  });
});
