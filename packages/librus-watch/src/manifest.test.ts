import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The package code and the shared code that kody-stage vendors into it.
const roots = [new URL("./", import.meta.url), new URL("../../shared/src/", import.meta.url)];
const codeLines = (text: string) => text.split("\n").filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  kody: { credentials: Record<string, { description: string }> };
};

function codeFiles(dir: URL): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === "fixtures" ? [] : codeFiles(new URL(`${entry.name}/`, dir));
    return /\.ts$/.test(entry.name) && !/\.test\.ts$|test-fixtures\.ts$/.test(entry.name) ? [readFileSync(new URL(entry.name, dir), "utf8")] : [];
  });
}

describe("Kody manifest", () => {
  it("declares every secret that the package code fills itself", () => {
    const used = new Set(roots.flatMap(codeFiles).flatMap(codeLines).flatMap((text) => [...text.matchAll(/\{\{secret:([A-Z0-9_]+)\}\}/g)].map((m) => m[1] ?? "")));
    expect([...used].sort()).toEqual(["SUPABASE_KEY", "TELEGRAM_BOT_TOKEN"]);
    for (const name of used) expect(manifest.kody.credentials[name]?.description).toBeTruthy();
  });
});
