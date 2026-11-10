#!/usr/bin/env -S node --experimental-strip-types
// Read-only: after the days-off deploy and the next librus-watch run, check that the Journal has the day-off Items
// and that `./stored-lessons` cancels the Lessons of those days. Do not run it before the deploy.
//
// Usage: node --experimental-strip-types tools/admin/src/check-days-off.ts --from 2026-11-12 --to 2026-11-13 \
//          [--expect 10] [--child-id <uuid>] [--input saved.json]
// It runs `kody execute --invoke kody:@tomiwu/librus-watch/stored-lessons` one time and `./stream-history` one time
// for each day-off source stream (Supabase only: at most 4 + N fetches, no Librus login). The Kody CLI must be signed
// in (KODY_API_TOKEN or `kody login`). `--input` checks a saved JSON ({ lastSavedAt, lessons, histories }) offline.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateDaysOff, sourceStreams, unwrap, type CheckHistory, type CheckLesson, type DaysOffInput } from "./days-off-check.ts";

const CLI = process.env.KODY_CLI ?? "@kodycodes/cli@3.34.2";
const MAX_STREAMS = 4;

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function invoke(exportName: string, params: Record<string, unknown>): unknown {
  const out = execFileSync("npx", ["-y", CLI, "execute", "--invoke", `kody:@tomiwu/librus-watch/${exportName}`, "--params", JSON.stringify(params), "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  return JSON.parse(out);
}

function live(from: string, to: string, childId: string | undefined): DaysOffInput {
  const stored = unwrap<{ lastSavedAt: string | null; lessons: CheckLesson[] }>(invoke("stored-lessons", { from, to, ...(childId ? { childId } : {}) }), "lessons");
  if (!stored) throw new Error("stored-lessons gave no lessons field");
  const histories = sourceStreams(stored.lessons).slice(0, MAX_STREAMS).map((stream) => {
    const history = unwrap<CheckHistory>(invoke("stream-history", { stream }), "events");
    return { stream, events: (history?.events ?? []).map(({ kind, eventType, day }) => ({ kind, eventType, day })) };
  });
  return { lastSavedAt: stored.lastSavedAt, lessons: stored.lessons, histories };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const from = option(args, "--from") ?? "2026-11-12";
  const to = option(args, "--to") ?? from;
  const expectLessons = Number(option(args, "--expect") ?? "10");
  const inputFile = option(args, "--input");
  const input = inputFile ? (JSON.parse(readFileSync(inputFile, "utf8")) as DaysOffInput) : live(from, to, option(args, "--child-id"));
  const result = evaluateDaysOff(input, { from, to, expectLessons });
  console.log(result.lines.join("\n"));
  console.log(result.ok ? "RESULT: GREEN" : "RESULT: RED");
  process.exitCode = result.ok ? 0 : 1;
}
