// Read stdin, mask the secrets, write stdout. Use it at the end of a pipe: loop 2>&1 | redact-filter.
// Secret sources: the values of REDACT_ENV_FILE (default .sandcastle/.env) and the secret-like
// variables of the environment.
import { existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { buildRedactor, parseEnvValues, secretValuesFromEnv } from "./src/redact.ts";

const envFile = process.env.REDACT_ENV_FILE || ".sandcastle/.env";
const fileValues = existsSync(envFile) ? parseEnvValues(readFileSync(envFile, "utf8")) : [];
const redact = buildRedactor([...fileValues, ...secretValuesFromEnv(process.env)]);

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) process.stdout.write(`${redact(line)}\n`);
