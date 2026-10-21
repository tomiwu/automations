import { spawnSync } from "node:child_process";
import { describe } from "vitest";
import { runStorageContract } from "./contract.ts";
import { createSupabaseStorage } from "./supabase.ts";

const url = process.env.POSTGREST_TEST_URL;
const key = process.env.POSTGREST_TEST_KEY;
const database = process.env.TEST_DATABASE_URL;
const enabled = Boolean(url && key && database);

function sql(statement: string): void {
  const result = spawnSync("psql", [database ?? "", "-v", "ON_ERROR_STOP=1", "-c", statement], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`);
}

const quote = (value: unknown): string => `'${JSON.stringify(value).replaceAll("'", "''")}'`;

/** The contract tests against a real PostgREST server on a Postgres database. They never use a real Supabase project. */
describe.skipIf(!enabled)("PostgREST server", () => {
  runStorageContract("supabase (PostgREST and Postgres)", async () => {
    sql("truncate outbox, items, recipients, activities, accounts, children, families cascade");
    return {
      storage: createSupabaseStorage({ url: url ?? "", key: key ?? "", fetch: (input, init) => fetch(input, init) }),
      seedConfig: async (config) => {
        const rows = (table: string, list: readonly object[]): string =>
          list.length === 0 ? "" : `insert into ${table} select * from json_populate_recordset(null::${table}, ${quote(list)});`;
        sql(
          [
            rows("families", [config.family]),
            rows("children", config.children),
            rows("accounts", config.accounts),
            rows("activities", config.activities),
            rows("recipients", config.recipients),
          ].join(" "),
        );
      },
      advanceDays: async (days) => {
        sql(`update outbox set queued_at = queued_at - interval '${days} days', delivered_at = delivered_at - interval '${days} days'`);
      },
    };
  });
});
