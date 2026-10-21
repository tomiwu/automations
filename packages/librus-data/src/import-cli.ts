import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { nodeRuntime, type Runtime } from "@automations/shared";
import { importKodyData, parseMigrationExport } from "./migration.ts";
import { supabaseStorageFromRuntime } from "./supabase.ts";

export interface ImportCliDeps {
  runtime: Runtime;
  readFile: (path: string) => Promise<string>;
  print: (line: string) => void;
}

/**
 * Imports an export file of the Kody job into Supabase and checks the counts.
 * The environment has SUPABASE_URL, SUPABASE_KEY and FAMILY_ID.
 */
export async function runImport(args: readonly string[], deps: ImportCliDeps): Promise<void> {
  const [path] = args;
  if (path === undefined) throw new Error("Usage: import-export <export-file>");
  const data = parseMigrationExport(await deps.readFile(path));
  const familyId = await deps.runtime.secret("FAMILY_ID");
  const storage = await supabaseStorageFromRuntime(deps.runtime);
  const report = await importKodyData(storage, familyId, data);
  for (const [watcher, count] of Object.entries(report.items)) deps.print(`items ${watcher}: ${count}`);
  deps.print(`pending outbox: ${report.pending}`);
  deps.print("Count check passed.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runImport(process.argv.slice(2), {
    runtime: nodeRuntime(),
    readFile: (path) => readFile(path, "utf8"),
    print: (line) => console.log(line),
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
