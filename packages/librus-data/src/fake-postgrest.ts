import { randomUUID } from "node:crypto";
import type { Config } from "@automations/shared";
import type { Fee } from "./storage.ts";

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

const DAY_MS = 86_400_000;
const CONTROL_PARAMS = new Set(["select", "order", "on_conflict", "limit"]);
const PRIMARY_KEYS: Record<string, readonly string[]> = {
  items: ["family_id", "watcher", "id"],
  outbox: ["key"],
  payments: ["fee_id", "month"],
  item_details: ["family_id", "scope", "source_id", "content_hash"],
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Reads `("a","b")` or `(a,b)`: a quoted value may hold commas, quotes and backslashes. */
function inPredicate(column: string, operand: string): Predicate {
  const members = operand.slice(1, -1).match(/"(?:[^"\\]|\\.)*"|[^,]+/g) ?? [];
  const values = members.map((member) => member.replace(/^"|"$/g, "").replace(/\\(.)/g, "$1"));
  return (row) => values.includes(String(row[column]));
}

const OPERATORS: Record<string, (column: string, operand: string) => Predicate> = {
  eq: (column, operand) => (row) => String(row[column]) === operand,
  is: (column) => (row) => row[column] === null,
  in: inPredicate,
  gte: (column, operand) => (row) => typeof row[column] === "string" && row[column] >= operand,
  lte: (column, operand) => (row) => typeof row[column] === "string" && row[column] <= operand,
  lt: (column, operand) => (row) => typeof row[column] === "string" && row[column] < operand,
};

function predicateFor(column: string, filter: string): Predicate {
  const dot = filter.indexOf(".");
  const build = OPERATORS[filter.slice(0, dot)];
  if (!build) throw new Error(`Filter ${filter} is not supported`);
  return build(column, filter.slice(dot + 1));
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
  seedFee(fee: Fee): void;
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

  const defaultsOf = (name: string): Row => {
    const time = current.toISOString();
    if (name === "payments") {
      const empty = { notified_at: null, reminded_at: null, decided_at: null, decided_by: null };
      return { id: randomUUID(), status: "pending", created_at: time, ...empty };
    }
    return { queued_at: time, delivered_at: null, first_seen: time };
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
      const stored = { ...defaultsOf(name), ...row };
      rows.push(stored);
      added.push(stored);
    }
    return added;
  };

  const EMBEDS: Record<string, readonly string[]> = { families: ["children", "accounts", "activities", "recipients"] };

  /** Supports the embedded selects of a Family: `children(*)` adds the rows whose `family_id` is the ID. */
  const embed = (rows: Row[], name: string, select: string | null): Row[] => {
    const wanted = (EMBEDS[name] ?? []).filter((child) => select?.includes(`${child}(*)`));
    return rows.map((row) => {
      const copy = { ...row };
      for (const child of wanted) copy[child] = table(child).filter((other) => other.family_id === row.id);
      return copy;
    });
  };

  const handle = (method: string, name: string, params: URLSearchParams, init?: RequestInit): Response => {
    const matches = predicatesOf(params);
    const selected = table(name).filter((row) => matches.every((test) => test(row)));
    const prefer = new Headers(init?.headers).get("prefer") ?? "";
    if (method === "GET") return json(embed(sortRows(selected, params.get("order")), name, params.get("select")));
    if (method === "POST") {
      const added = insert(name, JSON.parse(String(init?.body)) as Row[], prefer.includes("ignore-duplicates"));
      return prefer.includes("return=representation") ? json(added, 201) : new Response(null, { status: 201 });
    }
    if (method === "PATCH") {
      selected.forEach((row) => Object.assign(row, JSON.parse(String(init?.body))));
      return prefer.includes("return=representation") ? json(selected) : new Response(null, { status: 204 });
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
    seedFee: (fee) => {
      table("fees").push({
        id: fee.id,
        family_id: fee.familyId,
        child_id: fee.childId,
        organizer: fee.organizer,
        recipient_name: fee.recipientName,
        nip: fee.nip,
        account: fee.account,
        title: fee.title,
        due_day: fee.dueDay,
        notify_day: fee.notifyDay,
        reminder_day: fee.reminderDay,
        amounts: fee.amounts,
        source_url: fee.sourceUrl,
        account_id: fee.accountId,
        enabled: fee.enabled,
      });
    },
    advanceDays: (days) => {
      current = new Date(current.getTime() + days * DAY_MS);
    },
  };
}
