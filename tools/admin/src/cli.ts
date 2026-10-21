#!/usr/bin/env -S node --experimental-strip-types
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runAdmin } from "./commands.ts";
import { createRestClient } from "./rest.ts";

function restFromEnv() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment");
  return createRestClient({ url, key, fetch });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAdmin(process.argv.slice(2), {
    rest: restFromEnv,
    env: process.env,
    readFile: (path) => readFile(path, "utf8"),
    now: () => Date.now(),
    print: (line) => console.log(line),
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
