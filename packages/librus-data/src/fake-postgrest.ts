import type { Config } from "@automations/shared";

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

const DAY_MS = 86_400_000;
const CONTROL_PARAMS = new Set(["select", "order", "on_conflict", "limit"]);
const PRIMARY_KEYS: Record<string, readonly string[]> = {
  items: ["family_id", "watcher", "id"],
  outbox: ["key"],
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function predicateFor(column: string, filter: string): Predicate {
  const dot = filter.indexOf(".");
  const operator = filter.slice(0, dot);
  const operand = filter.slice(dot + 1);
  if (operator === "eq") return (row) => String(row[column]) === operand;
  if (operator === "is" && operand === "null") return (row) => row[column] === null;
  if (operator === "lt") return (row) => typeof row[column] === "string" && row[column] < operand;
  throw new Error(`Filter ${filter} is not supported`);
}

function predicatesOf(params: URLSearchParams): Predicate[] {
  return [...params].filter(([name]) => !CONTROL_PARAMS.has(name)).map(([name, value]) => predicateFor(name, value));
}

function sortRows(rows: Row[], order: string | null): Row[] {
  if (!order) return rows;
  const column = order.split(".")[0] ?? "";
  return [...rows].sort((a, b) => String(a[column]).localeCompare(String(b[column])));
}

/** A fake of the PostgREST API of Supabase. It keeps the tables in memory and uses no network. */
export interface FakePostgrest {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Every request that the fake received. */
  requests: { method: string; url: string; headers: Headers }[];
  seedConfig(config: Config): void;
  advanceDays(days: number): void;
}

export function createFakePostgrest(startTime: Date, expectedKey: string): FakePostgrest {
  let current = startTime;
  const tables = new Map<string, Row[]>();
  const requests: FakePostgrest["requests"] = [];
  const table = (name: string): Row[] => {
    const rows = tables.get(name) ?? [];
    tables.set(name, rows);
    return rows;
  };

  const insert = (name: string, body: Row[], ignoreDuplicates: boolean): Row[] => {
    const keys = PRIMARY_KEYS[name] ?? [];
    const rows = table(name);
    const added: Row[] = [];
    for (const row of body) {
      const same = (other: Row): boolean => keys.length > 0 && keys.every((key) => other[key] === row[key]);
      if (rows.some(same)) {
        if (!ignoreDuplicates) throw new Error("duplicate key");
        continue;
      }
      const stored = { queued_at: current.toISOString(), delivered_at: null, first_seen: current.toISOString(), ...row };
      rows.push(stored);
      added.push(stored);
    }
    return added;
  };

  const handle = (method: string, name: string, params: URLSearchParams, init?: RequestInit): Response => {
    const matches = predicatesOf(params);
    const selected = table(name).filter((row) => matches.every((test) => test(row)));
    const prefer = new Headers(init?.headers).get("prefer") ?? "";
    if (method === "GET") return json(sortRows(selected, params.get("order")));
    if (method === "POST") {
      const added = insert(name, JSON.parse(String(init?.body)) as Row[], prefer.includes("ignore-duplicates"));
      return prefer.includes("return=representation") ? json(added, 201) : new Response(null, { status: 201 });
    }
    if (method === "PATCH") {
      selected.forEach((row) => Object.assign(row, JSON.parse(String(init?.body))));
      return new Response(null, { status: 204 });
    }
    const rows = table(name);
    tables.set(name, rows.filter((row) => !selected.includes(row)));
    return prefer.includes("return=representation") ? json(selected) : new Response(null, { status: 204 });
  };

  return {
    requests,
    fetch: async (input, init) => {
      const url = new URL(input);
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      requests.push({ method, url: input, headers });
      if (headers.get("apikey") !== expectedKey || headers.get("authorization") !== `Bearer ${expectedKey}`) {
        return json({ message: "Invalid API key" }, 401);
      }
      return handle(method, url.pathname.replace("/rest/v1/", ""), url.searchParams, init);
    },
    seedConfig: (config) => {
      const withTime = (rows: readonly object[]): Row[] =>
        rows.map((row) => {
          const copy: Row = { ...row };
          if (typeof copy.start_time === "string") copy.start_time = `${copy.start_time}:00`;
          if (typeof copy.end_time === "string") copy.end_time = `${copy.end_time}:00`;
          return copy;
        });
      table("families").push({ ...config.family });
      table("children").push(...withTime(config.children));
      table("accounts").push(...withTime(config.accounts));
      table("activities").push(...withTime(config.activities));
      table("recipients").push(...withTime(config.recipients));
    },
    advanceDays: (days) => {
      current = new Date(current.getTime() + days * DAY_MS);
    },
  };
}
