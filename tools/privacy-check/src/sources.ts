// The text that the privacy check reads: the tracked files, a diff, the staged changes or the full git history.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** One line of text with its place: a path, or `commit <id>:<path>`, or `commit <id>:metadata`. */
export interface TextRecord {
  where: string;
  line: number;
  text: string;
}

export type Env = Record<string, string | undefined>;

const MAX_BUFFER = 1024 * 1024 * 1024;

function git(repo: string, env: Env, args: string[]): string {
  return execFileSync("git", ["-c", "core.quotePath=false", ...args], { cwd: repo, env: env as NodeJS.ProcessEnv, encoding: "utf8", maxBuffer: MAX_BUFFER });
}

/** A skip entry that ends with `/` is a directory. Other entries are full paths. */
export function isSkipped(path: string, skipPaths: string[]): boolean {
  return skipPaths.some((skip) => (skip.endsWith("/") ? path.startsWith(skip) : path === skip));
}

function fileLines(repo: string, path: string): TextRecord[] {
  const full = join(repo, path);
  if (!lstatSync(full, { throwIfNoEntry: false })?.isFile()) return [];
  const content = readFileSync(full);
  if (content.includes(0)) return [];
  return content.toString("utf8").split("\n").map((text, index) => ({ where: path, line: index + 1, text }));
}

export function treeRecords(repo: string, env: Env, skipPaths: string[]): TextRecord[] {
  return git(repo, env, ["ls-files", "-z"])
    .split("\0")
    .filter((path) => path !== "" && !isSkipped(path, skipPaths))
    .flatMap((path) => fileLines(repo, path));
}

const hunkStart = (text: string) => Number(/\+(\d+)/.exec(text)?.[1] ?? 0);

function hunkRecords(lines: string[], where: string): TextRecord[] {
  const records: TextRecord[] = [];
  let line = 0;
  for (const text of lines) {
    if (text.startsWith("@@ ")) line = hunkStart(text);
    else if (text.startsWith("+")) records.push({ where, line: line++, text: text.slice(1) });
  }
  return records;
}

/** One file of a patch: the header lines (with `+++ b/<path>`) and then the hunks. */
function fileRecords(section: string, prefix: string, skipPaths: string[]): TextRecord[] {
  const lines = section.split("\n");
  const firstHunk = lines.findIndex((text) => text.startsWith("@@ "));
  if (firstHunk < 0) return [];
  const path = lines.slice(0, firstHunk).find((text) => text.startsWith("+++ b/"))?.slice(6).replace(/\t$/, "");
  if (path === undefined || isSkipped(path, skipPaths)) return [];
  return hunkRecords(lines.slice(firstHunk), prefix + path);
}

/** The added lines of a `git diff -U0` or `git log -p -U0` patch. */
export function parsePatch(patch: string, prefix: string, skipPaths: string[]): TextRecord[] {
  return patch.split(/^diff --git /m).flatMap((section) => fileRecords(section, prefix, skipPaths));
}

const DIFF = ["diff", "-U0", "--no-color", "--no-ext-diff"];

export function diffRecords(repo: string, env: Env, base: string, skipPaths: string[]): TextRecord[] {
  return parsePatch(git(repo, env, [...DIFF, `${base}...HEAD`]), "", skipPaths);
}

export function stagedRecords(repo: string, env: Env, skipPaths: string[]): TextRecord[] {
  return parsePatch(git(repo, env, [...DIFF, "--cached"]), "", skipPaths);
}

const COMMIT_START = "\u0001";
const ID_END = "\u0002";
const MESSAGE_END = "\u0003";
const HISTORY_FORMAT = "--format=%x01%h%x02%an <%ae>%n%cn <%ce>%n%B%x03";

/** The author line, the committer line, the message and the added lines of each commit of the log text. */
export function parseHistory(log: string, skipPaths: string[]): TextRecord[] {
  return log.split(COMMIT_START).slice(1).flatMap((chunk) => {
    const [head = "", patch = ""] = chunk.split(MESSAGE_END);
    const [id = "", message = ""] = head.split(ID_END);
    const metadata = message.split("\n").map((text, index) => ({ where: `commit ${id}:metadata`, line: index + 1, text }));
    return [...metadata, ...parsePatch(patch, `commit ${id}:`, skipPaths)];
  });
}

export function historyRecords(repo: string, env: Env, skipPaths: string[]): TextRecord[] {
  return parseHistory(git(repo, env, ["log", "--all", "-p", "-U0", "--no-color", "--no-ext-diff", HISTORY_FORMAT]), skipPaths);
}
