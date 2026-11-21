#!/usr/bin/env -S node --experimental-strip-types
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export interface SnippetInput {
  supabaseUrl: string;
  familyId: string;
  credentialKey: string;
  withPayments: boolean;
  /** Dashboard user of payments-watch. Needed with `withPayments`. */
  paymentsUser?: string;
  /** Dashboard login token of payments-watch. Only its SHA-256 goes into the snippet. */
  paymentsToken?: string;
}

/** The `./configure` argument of payments-watch: the Dashboard allowlist with the token digest, never the token. */
function paymentsArg(input: SnippetInput): string {
  if (!input.paymentsUser) throw new Error("PAYMENTS_DASHBOARD_USER is empty");
  if (!input.paymentsToken) throw new Error("PAYMENTS_DASHBOARD_TOKEN is empty");
  const tokenDigest = createHash("sha256").update(input.paymentsToken).digest("hex");
  return `{ ...base, allowlist: ${JSON.stringify([{ user: input.paymentsUser, tokenDigest }])} }`;
}

/**
 * Builds the Kody `execute` code that calls `./configure` of each package with the same key. The result has the
 * key in it: write it only to a private temp file, never print it. The code returns `ok` or `failed: <reason>`
 * per package.
 */
export function configureSnippet(input: SnippetInput): string {
  const j = JSON.stringify;
  const packages = [
    ["librus-watch", "librus", "base"],
    ["activities-watch", "activities", "base"],
    ...(input.withPayments ? [["payments-watch", "payments", paymentsArg(input)]] : []),
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
    withPayments: e.WITH_PAYMENTS === "1",
    paymentsUser: v("PAYMENTS_DASHBOARD_USER"),
    paymentsToken: v("PAYMENTS_DASHBOARD_TOKEN"),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(snippetFromEnv(process.env));
