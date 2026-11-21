import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildDenylist, denylistEntries, denylistHit, parseDenylist, type Denylist } from "./denylist.ts";
import { scanLine, type Category } from "./heuristics.ts";
import { resolvePepper } from "./pepper.ts";
import { diffRecords, historyRecords, stagedRecords, treeRecords, type Env, type TextRecord } from "./sources.ts";

export const HASHES_PATH = "privacy/denylist.hashes.json";
export const ALLOWLIST_PATH = "privacy/allowlist.json";
export const PLAIN_LIST_PATH = ".privacy-denylist.txt";

type Mode = "tree" | "staged" | "diff" | "history";
type Print = (line: string) => void;

interface Options {
  command: "check" | "hash";
  repo: string;
  modes: Mode[];
  diffBase: string;
  input: string | undefined;
  requireWords: boolean;
}

interface Allowlist {
  paths: string[];
  values: Set<string>;
}

const VALUE_FLAGS = new Map<string, (options: Options, value: string) => void>([
  ["--repo", (options, value) => { options.repo = value; }],
  ["--in", (options, value) => { options.input = value; }],
  ["--diff", (options, value) => { options.diffBase = value; options.modes.push("diff"); }],
]);
const PLAIN_FLAGS = new Map<string, (options: Options) => void>([
  ["--tree", (options) => { options.modes.push("tree"); }],
  ["--staged", (options) => { options.modes.push("staged"); }],
  ["--history", (options) => { options.modes.push("history"); }],
  ["--require-words", (options) => { options.requireWords = true; }],
]);

function applyFlag(options: Options, flag: string, rest: string[]): boolean {
  const plain = PLAIN_FLAGS.get(flag);
  if (plain !== undefined) {
    plain(options);
    return true;
  }
  const value = rest.shift();
  const withValue = VALUE_FLAGS.get(flag);
  if (withValue === undefined || value === undefined) return false;
  withValue(options, value);
  return true;
}

const commandOf = (args: string[]): { command: Options["command"]; rest: string[] } =>
  args[0] === "hash" ? { command: "hash", rest: args.slice(1) } : { command: "check", rest: [...args] };

export function parseArgs(args: string[]): Options | string {
  const { command, rest } = commandOf(args);
  const options: Options = { command, repo: ".", modes: [], diffBase: "", input: undefined, requireWords: false };
  for (let flag = rest.shift(); flag !== undefined; flag = rest.shift()) {
    if (!applyFlag(options, flag, rest)) return `unknown argument: ${flag}`;
  }
  if (options.modes.length === 0) options.modes.push("tree");
  return options;
}

const readIfPresent = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

function readAllowlist(repo: string): Allowlist {
  const stored = JSON.parse(readIfPresent(join(repo, ALLOWLIST_PATH)) ?? "{}") as { paths?: string[]; values?: string[] };
  return { paths: stored.paths ?? [], values: new Set(stored.values ?? []) };
}

function records(mode: Mode, options: Options, env: Env, skipPaths: string[]): TextRecord[] {
  const readers: Record<Mode, () => TextRecord[]> = {
    tree: () => treeRecords(options.repo, env, skipPaths),
    staged: () => stagedRecords(options.repo, env, skipPaths),
    diff: () => diffRecords(options.repo, env, options.diffBase, skipPaths),
    history: () => historyRecords(options.repo, env, skipPaths),
  };
  return readers[mode]();
}

function findings(lines: TextRecord[], allowValues: Set<string>, isPrivate: (line: string) => boolean): string[] {
  return lines.flatMap((record) => {
    const categories: Category[] = scanLine(record.text, allowValues);
    if (isPrivate(record.text)) categories.push("private-word");
    return categories.map((category) => `${record.where}:${record.line}:${category}`);
  });
}

interface WordCheck {
  isPrivate: (line: string) => boolean;
  problem?: string;
}

function wordCheck(list: Denylist, pepper: string): WordCheck {
  if (list.peppered && pepper === "") return { isPrivate: () => false, problem: "PRIVACY_PEPPER is not set, the private word check did not run" };
  return { isPrivate: denylistHit(list, pepper) };
}

function scanModes(options: Options, env: Env, isPrivate: (line: string) => boolean): { found: Set<string>; counts: string[] } {
  const allow = readAllowlist(options.repo);
  const found = new Set<string>();
  const counts: string[] = [];
  for (const mode of new Set(options.modes)) {
    const lines = records(mode, options, env, allow.paths);
    counts.push(`${mode}: ${lines.length} lines`);
    findings(lines, allow.values, isPrivate).forEach((finding) => found.add(finding));
  }
  return { found, counts };
}

function report(found: Set<string>, summary: string, print: Print): number {
  found.forEach(print);
  if (found.size > 0) {
    print(`privacy: ${found.size} finding(s) (values hidden)`);
    return 1;
  }
  print(`privacy: no findings (${summary})`);
  return 0;
}

function check(options: Options, env: Env, print: Print, extraDirs: string[]): number {
  const list = parseDenylist(readIfPresent(join(options.repo, HASHES_PATH)));
  const words = wordCheck(list, list.peppered ? resolvePepper(env, options.repo, extraDirs) : "");
  if (words.problem !== undefined) {
    print(`privacy: ${options.requireWords ? "FAILED" : "WARNING"} ${words.problem}`);
    if (options.requireWords) return 1;
  }
  const { found, counts } = scanModes(options, env, words.isPrivate);
  return report(found, `${counts.join(", ")}, ${list.hashes.length} private word hashes`, print);
}

function hash(options: Options, env: Env, print: Print): number {
  const source = [options.input, env.DENYLIST_FILE, join(options.repo, PLAIN_LIST_PATH)].find((path) => path !== undefined && path !== "" && existsSync(path));
  if (source === undefined) {
    print(`privacy: no plain list. Write the private words to ${PLAIN_LIST_PATH} (git-ignored), or set DENYLIST_FILE or --in.`);
    return 2;
  }
  const plain = readFileSync(source, "utf8");
  const list = buildDenylist(plain, randomBytes(16).toString("hex"), resolvePepper(env, options.repo));
  mkdirSync(join(options.repo, "privacy"), { recursive: true });
  writeFileSync(join(options.repo, HASHES_PATH), `${JSON.stringify(list, null, 1)}\n`);
  print(`privacy: wrote ${list.hashes.length} hashes of ${denylistEntries(plain).length} entries to ${HASHES_PATH}${list.peppered ? " (with PRIVACY_PEPPER)" : ""}`);
  return 0;
}

/**
 * Exit code: 0 no finding, 1 findings, 2 usage error.
 * `extraDirs`: more checkouts whose `.env` can give the pepper (the CLI gives the current directory).
 */
export function run(args: string[], env: Env, print: Print, extraDirs: string[] = []): number {
  const options = parseArgs(args);
  if (typeof options === "string") {
    print(`privacy: ${options}`);
    return 2;
  }
  return options.command === "hash" ? hash(options, env, print) : check(options, env, print, extraDirs);
}
