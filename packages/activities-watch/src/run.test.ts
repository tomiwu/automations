import { createMemoryStorage } from "@automations/librus-data";
import { fakeRuntime } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { runActivitiesWatch, scopeOf, type RunDeps } from "./run.ts";
import type { CreateSource } from "./source.ts";
import { activityTargets } from "./targets.ts";
import { EDUSKY_ACCOUNT, FAMILY_ID, NOW_ACCOUNT, fakeSessionSource, session, testConfig, type FakeSessionSource } from "./test-fixtures.ts";

function setup(config = testConfig()) {
  const storage = createMemoryStorage({ configs: [config] });
  const runtime = fakeRuntime({ now: new Date("2026-10-20T08:00:00Z") });
  const sources = new Map<string, FakeSessionSource>();
  const createSource: CreateSource = (target) => {
    const source = sources.get(target.account.id) ?? fakeSessionSource();
    sources.set(target.account.id, source);
    return source;
  };
  const sent: string[] = [];
  const messenger = {
    send: async (chatId: string, text: string) => {
      sent.push(`${chatId}|${text}`);
    },
  };
  const deps: RunDeps = { runtime, storage, messenger, familyId: FAMILY_ID, createSource };
  sources.set(NOW_ACCOUNT, fakeSessionSource());
  sources.set(EDUSKY_ACCOUNT, fakeSessionSource());
  return { deps, sources, sent, storage, runtime };
}

describe("runActivitiesWatch", () => {
  it("records a Baseline, then delivers a cancellation to each Recipient of the Child", async () => {
    const { deps, sources, sent } = setup();
    sources.get(NOW_ACCOUNT)!.current = [session()];
    expect(await runActivitiesWatch(deps)).toEqual([]);
    expect(sent).toEqual([]);
    sources.get(NOW_ACCOUNT)!.current = [session({ status: "cancelled" })];
    expect(await runActivitiesWatch(deps)).toEqual([]);
    expect(sent).toEqual([
      "1000001|Class cancelled for Child One: Choir, 2026-10-27 15:00-16:00, Example Hall",
      "1000002|Zajęcia odwołane dla Child One: Choir, 2026-10-27 15:00-16:00, Example Hall",
    ]);
  });

  it("keeps the other Accounts running when one Account fails, and queues one failure Notification a day", async () => {
    const { deps, sources, sent } = setup();
    sources.get(NOW_ACCOUNT)!.error = new Error("ActiveNow: login rejected (check credentials)");
    const failures = await runActivitiesWatch(deps);
    expect(failures).toEqual(["Child One activenow: ActiveNow: login rejected (check credentials)"]);
    expect(sent).toEqual([
      "1000001|Login failed for Child One. Check the account.",
      "1000002|Logowanie nie powiodło się dla Child One. Sprawdź konto.",
    ]);
    await runActivitiesWatch(deps);
    expect(sent).toHaveLength(2);
  });

  it("renders another failure with its reason, without secret placeholders", async () => {
    const { deps, sources, sent } = setup();
    sources.get(EDUSKY_ACCOUNT)!.error = new Error("bad {{secret:X}}  value");
    await runActivitiesWatch(deps);
    expect(sent[0]).toBe("1000002|Pobieranie danych nie powiodło się dla Child Two: bad [secret] value");
  });

  it("cuts a long failure reason", async () => {
    const { deps, sources, sent } = setup();
    sources.get(EDUSKY_ACCOUNT)!.error = new Error("x".repeat(400));
    await runActivitiesWatch(deps);
    expect(sent[0]?.length).toBeLessThan(400);
    expect(sent[0]).toContain("…");
  });

  it("reports the error of a bad Account and still runs the others", async () => {
    const config = testConfig();
    config.accounts[0] = { ...config.accounts[0]!, password_secret: "" };
    const { deps } = setup(config);
    const failures = await runActivitiesWatch(deps);
    expect(failures).toEqual([expect.stringContaining("password_secret is missing")]);
  });

  it("reports a delivery failure and keeps the entry in the Outbox", async () => {
    const { deps, sources, storage } = setup();
    sources.get(NOW_ACCOUNT)!.current = [session()];
    await runActivitiesWatch(deps);
    sources.get(NOW_ACCOUNT)!.current = [session({ status: "cancelled" })];
    const failing = { ...deps, messenger: { send: async () => Promise.reject(new Error("telegram down")) } };
    expect(await runActivitiesWatch(failing)).toEqual(["deliver: telegram down"]);
    expect(await storage.pendingNotifications(FAMILY_ID)).toHaveLength(2);
  });

  it("logs each Account and never the secret values", async () => {
    const { deps, runtime } = setup();
    await runActivitiesWatch(deps);
    expect(runtime.logs.map((l) => l.message)).toContain(`account ${NOW_ACCOUNT}: ok`);
  });

  it("appends Session events, fails with journal: when the append fails, and skips a failed Account", async () => {
    const { deps, sources, storage } = setup();
    sources.get(NOW_ACCOUNT)!.current = [session()];
    sources.get(EDUSKY_ACCOUNT)!.error = new Error("down");
    await runActivitiesWatch(deps);
    const types = (await storage.listEvents(FAMILY_ID)).map((e) => e.eventType);
    expect(types.sort()).toEqual(["CheckCompleted", "SessionScheduled"]);
    storage.appendEvents = async () => Promise.reject(new Error("conflict"));
    const failures = await runActivitiesWatch(deps);
    expect(failures).toContain("journal: conflict");
  });

  it("reads the sources once as before and makes at most 3 Journal calls for the whole run", async () => {
    const { deps, sources, storage } = setup();
    let reads = 0;
    for (const source of sources.values()) {
      const read = source.sessions.bind(source);
      source.sessions = async () => (reads++, read());
    }
    const calls: string[] = [];
    const heads = storage.listHeads.bind(storage);
    const append = storage.appendEvents.bind(storage);
    storage.listHeads = (...args) => (calls.push("heads"), heads(...args));
    storage.appendEvents = (...args) => (calls.push("append"), append(...args));
    sources.get(NOW_ACCOUNT)!.current = [session()];
    await runActivitiesWatch(deps);
    expect(reads).toBe(2);
    expect(calls).toEqual(["heads", "heads", "append"]);
  });

  it("builds the scope from the Service and the Account", () => {
    expect(scopeOf(activityTargets(testConfig()).targets[1]!)).toBe(`edusky:${EDUSKY_ACCOUNT}`);
  });
});
