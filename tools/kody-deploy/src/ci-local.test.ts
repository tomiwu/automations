import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const script = join(root, "scripts", "ci-local.sh");
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function parity(workflows: string) {
  const result = spawnSync("bash", [script, "--check-parity"], { env: { PATH: process.env.PATH, CI_LOCAL_WORKFLOWS: workflows }, encoding: "utf8" });
  return { status: result.status, out: result.stdout + result.stderr };
}

function copyOfWorkflows(): string {
  const dir = mkdtempSync(join(tmpdir(), "ci-local-"));
  dirs.push(dir);
  cpSync(join(root, ".github", "workflows"), dir, { recursive: true });
  return dir;
}

describe("scripts/ci-local.sh --check-parity", () => {
  it("maps every step of the real workflows", () => {
    const { status, out } = parity(join(root, ".github", "workflows"));
    expect(out).toMatch(/parity ok: \d+ workflow steps mapped/);
    expect(status).toBe(0);
  });

  it("fails when ci.yml gets a step with no local step", () => {
    const dir = copyOfWorkflows();
    const ci = join(dir, "ci.yml");
    writeFileSync(ci, readFileSync(ci, "utf8").replace("      - name: Run the tests\n", "      - name: Run a new lint step\n        run: npm run lint\n      - name: Run the tests\n"));
    const { status, out } = parity(dir);
    expect(status).toBe(1);
    expect(out).toContain("PARITY FAIL: workflow step has no local step: ci.yml|Run a new lint step");
  });

  it("fails when a new workflow file has a named step", () => {
    const dir = copyOfWorkflows();
    writeFileSync(join(dir, "extra.yml"), "name: Extra\non: push\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps:\n      - name: \"Do a thing\"\n        run: echo x\n");
    const { status, out } = parity(dir);
    expect(status).toBe(1);
    expect(out).toContain("extra.yml|Do a thing");
  });
});
