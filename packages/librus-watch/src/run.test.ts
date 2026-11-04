import { createMemoryStorage } from "@automations/librus-data";
import { fakeRuntime } from "@automations/shared";
import { describe, expect, it } from "vitest";
import type { Messenger } from "./deliver.ts";
import { librusTargets, runLibrusWatch, type RunDeps } from "./run.ts";
import { ACCOUNT1, CHILD1, CHILD2, FAMILY_ID, fakeSource, testConfig } from "./test-fixtures.ts";

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
