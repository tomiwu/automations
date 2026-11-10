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
  journal_events: ["family_id", "stream", "seq"],
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

const compare = (column: string, operand: string, test: (a: string, b: string) => boolean): Predicate => (row) =>
  typeof row[column] === "string" && test(row[column] as string, operand);

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** Like Postgres `date`: a `YYYY-MM-DD` operand that is not a real day (for example `2026-11-31`) is a 400. */
function checkDate(operand: string): string {
  if (DATE_SHAPE.test(operand) && new Date(`${operand}T00:00:00Z`).toISOString().slice(0, 10) !== operand) {
    throw new FakeBadRequest(`date/time field value out of range: "${operand}"`);
  }
  return operand;
}

/** A filter that Postgres would reject with 400. */
class FakeBadRequest extends Error {}

const OPERATORS: Record<string, (column: string, operand: string) => Predicate> = {
  eq: (column, operand) => (row) => String(row[column]) === operand,
  is: (column) => (row) => row[column] === null,
  in: inPredicate,
  gte: (column, operand) => compare(column, checkDate(operand), (a, b) => a >= b),
  lte: (column, operand) => compare(column, checkDate(operand), (a, b) => a <= b),
  lt: (column, operand) => compare(column, checkDate(operand), (a, b) => a < b),
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

function compareColumn(a: Row, b: Row, term: string): number {
  const [column = "", direction] = term.split(".");
  const left = a[column];
  const right = b[column];
  const order =
    typeof left === "number" && typeof right === "number" ? left - right : String(left).localeCompare(String(right));
  return direction === "desc" ? -order : order;
}

function sortRows(rows: Row[], order: string | null): Row[] {
  if (!order) return rows;
  const terms = order.split(",");
  return [...rows].sort((a, b) => terms.reduce((result, term) => result || compareColumn(a, b, term), 0));
}

/** The last event of each stream, as the view `journal_heads` gives it. */
function headsOf(events: Row[]): Row[] {
  const last = new Map<string, Row>();
  for (const event of events) {
    const slot = JSON.stringify([event.family_id, event.stream]);
    const head = last.get(slot);
    if (!head || Number(head.seq) < Number(event.seq)) last.set(slot, event);
  }
  return [...last.values()];
}

class DuplicateKeyError extends Error {}

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
    if (name === "journal_events") return { recorded_at: time };
    return { queued_at: time, delivered_at: null, first_seen: time };
  };

  const insert = (name: string, body: Row[], ignoreDuplicates: boolean): Row[] => {
    const keys = PRIMARY_KEYS[name] ?? [];
    const rows = table(name);
    const added: Row[] = [];
    for (const row of body) {
      const same = (other: Row): boolean => keys.length > 0 && keys.every((key) => other[key] === row[key]);
      if (rows.some(same) || added.some(same)) {
        if (!ignoreDuplicates) throw new DuplicateKeyError("duplicate key");
        continue;
      }
      added.push({ ...defaultsOf(name), ...row });
    }
    rows.push(...added);
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
    const source = name === "journal_heads" ? headsOf(table("journal_events")) : table(name);
    const selected = source.filter((row) => matches.every((test) => test(row)));
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
      try {
        return handle(method, url.pathname.replace("/rest/v1/", ""), url.searchParams, init);
      } catch (error) {
        if (error instanceof DuplicateKeyError) return json({ code: "23505", message: error.message }, 409);
        if (error instanceof FakeBadRequest) return json({ code: "22008", message: error.message }, 400);
        throw error;
      }
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
