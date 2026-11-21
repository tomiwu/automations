import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Env } from "./sources.ts";

const ENV_LINE = /^\s*(?:export\s+)?PRIVACY_PEPPER\s*=\s*(.*)$/;

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(["'])(.*)\1$/.exec(trimmed);
  return quoted ? (quoted[2] ?? "") : trimmed.replace(/\s+#.*$/, "");
}

export function pepperFromDotenv(text: string): string {
  const line = text.split(/\r?\n/).map((row) => ENV_LINE.exec(row)).find((match) => match !== null);
  return line ? unquote(line[1] ?? "") : "";
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function mainCheckout(dir: string): string | undefined {
  try {
    const common = execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return dirname(common);
  } catch {
    return undefined;
  }
}

function dotenvFiles(dirs: string[]): string[] {
  return dirs.flatMap((dir) => [dir, mainCheckout(dir)]).filter((dir): dir is string => dir !== undefined).map((dir) => join(dir, ".env"));
}

export function resolvePepper(env: Env, repo: string, extraDirs: string[] = []): string {
  if (env.PRIVACY_PEPPER) return env.PRIVACY_PEPPER;
  if (env.PRIVACY_PEPPER_FILE) return readText(env.PRIVACY_PEPPER_FILE).trim();
  return dotenvFiles([repo, ...extraDirs]).map((path) => pepperFromDotenv(readText(path))).find((value) => value !== "") ?? "";
}
