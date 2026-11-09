import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The Kody publish check parses package sources in TSX mode. In TSX, a generic
// arrow function with one bare type parameter (`<S>(x: S) => ...`) reads as a JSX
// tag, so publish fails although tsc accepts the file. Use `function f<S>()` or `<S,>`.
const packagesDir = join(import.meta.dirname, "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [path] : [];
  });
}

function tsxErrors(path: string): string[] {
  const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const diagnostics = (source as unknown as { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
  return diagnostics.map((d) => `${relative(packagesDir, path)}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
}

describe("package sources", () => {
  const files = readdirSync(packagesDir).flatMap((pkg) => sourceFiles(join(packagesDir, pkg, "src")));

  it("finds the sources", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("parse in TSX mode, as the Kody publish check reads them", () => {
    expect(files.flatMap(tsxErrors)).toEqual([]);
  });
});
