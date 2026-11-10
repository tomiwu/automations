import { createMemoryStorage } from "@automations/librus-data";
import { countFetches, createFetchBudget, fakeRuntime, LEDGER_KEY, type LedgerStore } from "@automations/shared";
import { describe, expect, it } from "vitest";
import type { Messenger } from "./deliver.ts";
import { librusTargets, OPTIONAL_WATCHERS, runLibrusWatch, type RunDeps } from "./run.ts";
import { ACCOUNT1, CHILD1, CHILD2, FAMILY_ID, fakeSource, lesson, testConfig } from "./test-fixtures.ts";

function setup(mutate: (config: ReturnType<typeof testConfig>) => void = () => {}) {
  const config = testConfig();
  mutate(config);
  const storage = createMemoryStorage({ configs: [config] });
  const runtime = fakeRuntime({ now: new Date("2026-01-05T04:30:00Z") });
  const source = fakeSource();
  const sent: string[] = [];
  const messenger: Messenger = {
    async send(chatId, text) {
      sent.push(`${chatId}|${text}`);
    },
  };
  const deps: RunDeps = { runtime, storage, messenger, familyId: FAMILY_ID, createSource: () => source };
  return { config, storage, runtime, source, sent, deps };
}

describe("librusTargets", () => {
  it("takes only enabled Librus Accounts of Children with has_librus, with their Recipients", () => {
    const { config } = setup();
    const { targets, errors } = librusTargets(config);
    expect(errors).toEqual([]);
    expect(targets.map((t) => [t.child.id, t.recipients.map((r) => r.telegram_chat_id)])).toEqual([[CHILD1, ["1000001", "1000002"]]]);
  });

  it("gives one error for a bad Account and keeps the others", () => {
    const { config } = setup();
    const good = config.accounts[0]!;
    config.accounts = [{ ...good, id: "bad", service: "unknown" as never }, good, { ...good, id: "off", enabled: false }, { ...good, id: "kid2", child_id: CHILD2 }];
    const { targets, errors } = librusTargets(config);
    expect(errors).toEqual(['Account bad: unknown service "unknown"']);
    expect(targets.map((t) => t.account.id)).toEqual([ACCOUNT1]);
  });
});

describe("runLibrusWatch", () => {
  it("queues the Notifications of one Watcher with one storage call", async () => {
    const { deps, storage, source } = setup();
    await runLibrusWatch(deps);
    const sizes: number[] = [];
    const enqueue = storage.enqueueNotifications;
    storage.enqueueNotifications = async (entries) => (sizes.push(entries.length), enqueue(entries));
    source.items.grades = [{ id: "1", subject: "Math", grade: "5", date: "", category: "", teacher: "" }, { id: "2", subject: "Art", grade: "4", date: "", category: "", teacher: "" }];
    await runLibrusWatch(deps);
    expect(sizes).toContain(4);
  });

  it("baselines on the first run, then delivers a new grade in each language", async () => {
    const { deps, source, sent } = setup();
    expect(await runLibrusWatch(deps)).toEqual([]);
    expect(sent.map((s) => s.split("\n")[0])).toEqual(["1000001|Morning report for Child One, Monday 05.01", "1000002|Raport poranny dla Child One, poniedziałek 05.01"]);
    sent.length = 0;
    source.items.grades = [{ id: "1", subject: "Math", grade: "5", date: "", category: "", teacher: "" }];
    expect(await runLibrusWatch(deps)).toEqual([]);
    expect(sent).toEqual(["1000001|New grade for Child One: Math, 5", "1000002|Nowa ocena dla Child One: Math, 5"]);
  });

  it("sends the Morning report once on a report run", async () => {
    const { deps, sent } = setup();
    await runLibrusWatch(deps);
    expect(sent.map((s) => s.split(" ")[0] + " " + s.split(" ")[1])).toEqual(["1000001|Morning report", "1000002|Raport poranny"]);
    sent.length = 0;
    await runLibrusWatch(deps);
    expect(sent).toEqual([]);
  });

  it("reports a failed Watcher, sends one failure Notification a day and still delivers the rest", async () => {
    const { deps, source, sent, runtime } = setup();
    runtime.setNow(new Date("2026-01-05T12:30:00Z"));
    const original = source.currentItems;
    source.currentItems = async (watcher, since) => {
      if (watcher === "grades") throw new Error("Librus: no access");
      return original(watcher, since);
    };
    const failures = await runLibrusWatch(deps);
    expect(failures).toEqual(["Child One: grades: Librus: no access"]);
    expect(sent[0]).toBe("1000001|Data fetch failed for Child One: grades: Librus: no access");
    expect(sent[1]).toContain("Pobieranie danych nie powiodło się dla Child One");
    sent.length = 0;
    await runLibrusWatch(deps);
    expect(sent).toEqual([]);
  });

  it("sends a login error text when the login is rejected", async () => {
    const { deps, source, sent, runtime } = setup();
    runtime.setNow(new Date("2026-01-05T12:30:00Z"));
    source.currentItems = async () => {
      throw new Error("Librus: login rejected (check credentials)");
    };
    await runLibrusWatch(deps);
    expect(sent[0]).toBe("1000001|Login failed for Child One. Check the account.");
  });

  it("does not fail the run when the morning report fails", async () => {
    const { deps, source, runtime } = setup();
    source.timetable = async () => {
      throw new Error("down");
    };
    expect(await runLibrusWatch(deps)).toEqual([]);
    expect(runtime.logs.some((l) => l.level === "warn" && l.message === "morning report failed: down")).toBe(true);
  });

  it("reports a journal failure like a Watcher failure and still sends the Morning report", async () => {
    const { deps, storage, sent } = setup();
    storage.listHeads = async () => {
      throw new Error("heads down");
    };
    const failures = await runLibrusWatch(deps);
    expect(failures).toEqual(["Child One: journal: heads down"]);
    expect(sent.some((s) => s.includes("Morning report"))).toBe(true);
  });

  it("appends the Journal events of the Child with the source 'librus-watch'", async () => {
    const { deps, storage, source } = setup();
    source.lessons = [lesson("2026-01-05", 1, "Math")];
    await runLibrusWatch(deps);
    const events = await storage.listEvents(FAMILY_ID);
    expect(events.map((e) => [e.stream.split(":")[0], e.eventType, e.source])).toEqual([
      ["check", "CheckCompleted", "librus-watch"],
      ["lesson", "LessonScheduled", "librus-watch"],
    ]);
  });

  it("returns a delivery failure and a config error", async () => {
    const { deps, config } = setup((c) => {
      c.accounts.push({ ...c.accounts[0]!, id: "bad", service: "nope" as never });
    });
    deps.messenger = {
      async send() {
        throw new Error("telegram down");
      },
    };
    const failures = await runLibrusWatch(deps);
    expect(failures).toEqual(['Account bad: unknown service "nope"', "deliver: telegram down"]);
    expect(config.accounts).toHaveLength(2);
  });

  it("uses the Librus source of the Runtime when no source is given", async () => {
    const { deps, runtime } = setup();
    const failures = await runLibrusWatch({ ...deps, createSource: undefined });
    expect(failures.length).toBeGreaterThan(0);
    expect(runtime.requests.length).toBeGreaterThan(0);
  });
});

function ledgerStore(used: number): LedgerStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>([[LEDGER_KEY, JSON.stringify({ week: "2026-01-05", used })]]);
  return { data, get: async (key) => data.get(key), set: async (key, value) => void data.set(key, value) };
}

describe("runLibrusWatch fetch reserve", () => {
  async function watchedAfter(used: number, reserve?: number) {
    const { deps, source, runtime } = setup();
    const store = ledgerStore(used);
    const budget = createFetchBudget({ store, now: () => runtime.now() });
    const read: string[] = [];
    const current = source.currentItems;
    source.currentItems = async (watcher, since) => (read.push(watcher), current(watcher, since));
    await runLibrusWatch({ ...deps, budget, fetchReserve: reserve });
    return { read, logs: runtime.logs.map((l) => l.message) };
  }

  it("skips the optional Watchers below the reserve and logs one line", async () => {
    const { read, logs } = await watchedAfter(2400);
    for (const watcher of OPTIONAL_WATCHERS) expect(read).not.toContain(watcher);
    expect(read).toEqual(expect.arrayContaining(["homework", "substitutions", "lessons", "schoolFreeDays", "classFreeDays"]));
    expect(logs).toContain("budget reserve: skipped grades, messages, announcements, trips, absences, meetings");
  });

  it("changes nothing above the reserve", async () => {
    const { read, logs } = await watchedAfter(100);
    expect(read).toEqual(expect.arrayContaining([...OPTIONAL_WATCHERS]));
    expect(logs.some((line) => line.startsWith("budget reserve"))).toBe(false);
  });

  it("uses the reserve of the config", async () => {
    const { read } = await watchedAfter(2400, 50);
    expect(read).toContain("grades");
  });

  it("adds the fetches of the run to the ledger and marks a plan-limit error", async () => {
    const { deps, source, runtime } = setup();
    const store = ledgerStore(10);
    const budget = createFetchBudget({ store, now: () => runtime.now() });
    const counter = countFetches(async () => new Response("ok"));
    await counter.fetch("https://example.test/a");
    source.currentItems = async () => {
      throw Object.assign(new Error("Plan limit reached"), { name: "EntitlementLimitError" });
    };
    await runLibrusWatch({ ...deps, budget, counter });
    expect(JSON.parse(store.data.get(LEDGER_KEY) as string)).toEqual({ week: "2026-01-05", used: 11, capHitDay: "2026-01-05" });
  });

  it("logs a ledger failure and does not fail the run", async () => {
    const { deps, runtime } = setup();
    const budget = { remaining: async () => 2500, record: async () => Promise.reject(new Error("storage down")) };
    const counter = countFetches(async () => new Response("ok"));
    expect(await runLibrusWatch({ ...deps, budget, counter })).toEqual([]);
    expect(runtime.logs.map((l) => l.message)).toContain("fetch ledger: storage down");
  });
});
