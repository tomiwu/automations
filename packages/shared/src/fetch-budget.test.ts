import { describe, expect, it } from "vitest";
import {
  LEDGER_KEY,
  belowReserve,
  createFetchBudget,
  formatReserveSkip,
  isFetchCapError,
  loadLedger,
  utcWeekOf,
  type LedgerStore,
} from "./fetch-budget.ts";

function memoryStore(initial?: unknown): LedgerStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(initial === undefined ? [] : [[LEDGER_KEY, initial]]);
  return { data, get: async (key) => data.get(key), set: async (key, value) => void data.set(key, value) };
}

const WED = new Date("2026-01-07T10:00:00Z");

describe("isFetchCapError", () => {
  it("knows the Kody plan-limit error by name or text", () => {
    const named = Object.assign(new Error("Plan limit reached"), { name: "EntitlementLimitError" });
    expect(isFetchCapError(named)).toBe(true);
    expect(isFetchCapError(new Error("EntitlementLimitError: Plan limit reached"))).toBe(true);
    expect(isFetchCapError("payments: plan limit reached")).toBe(true);
    expect(isFetchCapError(new Error("HTTP 500"))).toBe(false);
  });
});

describe("utcWeekOf", () => {
  it("gives the Monday of the UTC week", () => {
    expect(utcWeekOf(WED)).toBe("2026-01-05");
    expect(utcWeekOf(new Date("2026-01-05T00:00:00Z"))).toBe("2026-01-05");
    expect(utcWeekOf(new Date("2026-01-04T23:59:59Z"))).toBe("2025-12-29");
  });
});

describe("loadLedger", () => {
  it("starts at zero for a new week, a damaged value or no value", async () => {
    expect(await loadLedger(memoryStore(), WED)).toEqual({ week: "2026-01-05", used: 0 });
    expect(await loadLedger(memoryStore("{bad"), WED)).toEqual({ week: "2026-01-05", used: 0 });
    expect(await loadLedger(memoryStore(JSON.stringify({ week: "2025-12-29", used: 900 })), WED)).toEqual({ week: "2026-01-05", used: 0 });
  });

  it("reads the ledger of the week, also as an object", async () => {
    expect(await loadLedger(memoryStore({ week: "2026-01-05", used: 40 }), WED)).toEqual({ week: "2026-01-05", used: 40 });
  });
});

describe("createFetchBudget", () => {
  it("counts down from the weekly limit", async () => {
    const store = memoryStore();
    const budget = createFetchBudget({ store, now: () => WED, limit: 100 });
    expect(await budget.remaining()).toBe(100);
    await budget.record(30);
    await budget.record(80);
    expect(await budget.remaining()).toBe(0);
    expect(JSON.parse(store.data.get(LEDGER_KEY) as string)).toEqual({ week: "2026-01-05", used: 110 });
  });

  it("gives 0 for the rest of the UTC day after a plan-limit error, then the count again", async () => {
    const store = memoryStore();
    let now = WED;
    const budget = createFetchBudget({ store, now: () => now });
    await budget.record(5, true);
    expect(await budget.remaining()).toBe(0);
    now = new Date("2026-01-08T00:30:00Z");
    expect(await budget.remaining()).toBe(2495);
  });
});

describe("belowReserve", () => {
  it("compares the remaining fetches with the reserve", async () => {
    const budget = createFetchBudget({ store: memoryStore({ week: "2026-01-05", used: 2400 }), now: () => WED });
    expect(await belowReserve(budget)).toBe(true);
    expect(await belowReserve(budget, 100)).toBe(false);
    expect(await belowReserve(undefined)).toBe(false);
  });

  it("formats the log line", () => {
    expect(formatReserveSkip(["grades", "messages"])).toBe("budget reserve: skipped grades, messages");
  });
});
