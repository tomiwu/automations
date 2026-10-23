#!/usr/bin/env -S node --experimental-strip-types
import { fileURLToPath } from "node:url";

export interface SnippetInput {
  supabaseUrl: string;
  familyId: string;
  credentialKey: string;
  /** JSON list of Telegram chat IDs for kradziejka. */
  allowlist: string;
  adminToken: string;
  withPayments: boolean;
}

/**
 * Builds the Kody `execute` code that calls `./configure` of each package with the same key. The result has the
 * key in it: write it only to a private temp file, never print it. The code returns `ok` or `failed: <reason>`
 * per package.
 */
export function configureSnippet(input: SnippetInput): string {
  const j = JSON.stringify;
  const allowlist: unknown = JSON.parse(input.allowlist);
  if (!Array.isArray(allowlist)) throw new Error("KRADZIEJKA_ALLOWLIST must be a JSON list");
  const packages = [
    ["librus-watch", "librus", "base"],
    ["activities-watch", "activities", "base"],
    ["kradziejka", "kradziejka", `{ ...base, allowlist: ${j(allowlist.map(String))}, adminToken: ${j(input.adminToken)} }`],
    ...(input.withPayments ? [["payments-watch", "payments", "base"]] : []),
  ];
  return [
    ...packages.map(([pkg, id]) => `import ${id} from "kody:@tomiwu/${pkg}/configure";`),
    "export default async () => {",
    `  const base = { supabaseUrl: ${j(input.supabaseUrl)}, familyId: ${j(input.familyId)}, credentialKey: ${j(input.credentialKey)} };`,
    "  const steps: [string, () => Promise<unknown>][] = [",
    ...packages.map(([pkg, id, arg]) => `    [${j(pkg)}, () => ${id}(${arg})],`),
    "  ];",
    "  const out: Record<string, string> = {};",
    "  for (const [name, run] of steps) {",
    '    try { await run(); out[name] = "ok"; } catch (err) { out[name] = "failed: " + (err instanceof Error ? err.message : String(err)); }',
    "  }",
    "  return out;",
    "};",
    "",
  ].join("\n");
}

/** Reads the snippet input from the environment of `rekey.sh`. */
export function snippetFromEnv(e: Record<string, string | undefined>): string {
  const v = (name: string, fallback = ""): string => e[name] ?? fallback;
  return configureSnippet({
    supabaseUrl: v("SUPABASE_URL"),
    familyId: v("FAMILY_ID"),
    credentialKey: v("NEW_CREDENTIAL_KEY"),
    allowlist: v("KRADZIEJKA_ALLOWLIST", "[]"),
    adminToken: v("KRADZIEJKA_ADMIN_TOKEN"),
    withPayments: e.WITH_PAYMENTS === "1",
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(snippetFromEnv(process.env));
