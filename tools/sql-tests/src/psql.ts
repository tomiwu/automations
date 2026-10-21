import { spawnSync } from "node:child_process";

export interface PsqlResult {
  ok: boolean;
  output: string;
}

export function psql(url: string, sql: string): PsqlResult {
  const run = spawnSync("psql", ["-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-d", url, "-c", sql], {
    encoding: "utf8",
  });
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}`.trim() };
}

export function asWatcher(url: string, sql: string): PsqlResult {
  return psql(url, `begin; set local role automations_watcher; ${sql}; rollback`);
}
