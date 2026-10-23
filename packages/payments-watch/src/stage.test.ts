import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
let out: string;

function readManifest() {
  return JSON.parse(readFileSync(join(out, "package.json"), "utf8"));
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "stage-payments-"));
  execFileSync("node", [join(repoRoot, "tools/kody-stage/stage.mjs"), join(repoRoot, "packages/payments-watch"), out], { stdio: "pipe" });
});

afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("Kody staging of payments-watch", () => {
  it("bundles the workspace dependencies and the entry files", () => {
    for (const name of ["shared", "librus-data", "librus-watch"]) {
      expect(existsSync(join(out, "vendor", name, "src"))).toBe(true);
    }
    expect(existsSync(join(out, "src/entry/scheduled.ts"))).toBe(true);
    expect(existsSync(join(out, "src/entry/app.ts"))).toBe(true);
  });

  it("keeps the kody block with the job, the app and the credential", () => {
    const manifest = readManifest();
    expect(manifest.kody.jobs["scheduled-check"].entry).toBe("./src/entry/scheduled.ts");
    expect(manifest.kody.app.entry).toBe("./src/entry/app.ts");
    expect(Object.keys(manifest.kody.credentials)).toEqual(["SUPABASE_KEY"]);
    expect(manifest.kody.dependencies).toEqual({ "@tomiwu/telegram": "*" });
    expect(manifest.private).toBe(true);
  });

  it("leaves no workspace dependency, script or test file in the tree", () => {
    const manifest = readManifest();
    expect(Object.keys(manifest.dependencies).filter((d) => d.startsWith("@automations/") || d === "@tomiwu/librus-watch")).toEqual([]);
    expect(manifest.scripts).toBeUndefined();
    expect(listFiles(out).filter((file) => file.endsWith(".test.ts"))).toEqual([]);
  });
});
