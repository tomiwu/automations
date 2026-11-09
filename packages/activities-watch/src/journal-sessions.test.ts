import { createMemoryStorage } from "@automations/librus-data";
import { describe, expect, it } from "vitest";
import { appendSessionsJournal } from "./journal-sessions.ts";
import type { Session } from "./sessions.ts";
import { activityTargets } from "./targets.ts";
import { FAMILY_ID, NOW_ACCOUNT, session, testConfig } from "./test-fixtures.ts";

const NOW = new Date("2026-10-20T08:00:00Z");
const [NOW_TARGET, EDUSKY_TARGET] = activityTargets(testConfig()).targets;

const dance = (overrides: Partial<Session> = {}) =>
  session({ childId: "c2", activity: "Dance", service: "edusky", id: "dance:1", ...overrides });

function setup() {
  const storage = createMemoryStorage({ now: () => NOW });
  const logs: string[] = [];
  const pass = (now: Sessions, edusky: Sessions = []) => {
    const accounts = [
      ...(now ? [{ target: NOW_TARGET!, sessions: now }] : []),
      ...(edusky ? [{ target: EDUSKY_TARGET!, sessions: edusky }] : []),
    ];
    return appendSessionsJournal({ storage, familyId: FAMILY_ID, accounts, timezone: "UTC", now: NOW, log: (m) => logs.push(m) });
  };
  const types = async (prefix: string) =>
    (await storage.listEvents(FAMILY_ID)).filter((e) => e.stream.startsWith(prefix)).map((e) => e.eventType);
  return { storage, logs, pass, types };
}

type Sessions = Session[] | null;

describe("appendSessionsJournal", () => {
  it("appends SessionScheduled and CheckCompleted, then only CheckCompleted for the same data", async () => {
    const { storage, pass, types, logs } = setup();
    expect(await pass([session()], [dance()])).toBe(4);
    expect(await pass([session()], [dance()])).toBe(2);
    expect(await types("session:")).toEqual(["SessionScheduled", "SessionScheduled"]);
    expect(await types("check:")).toEqual(["CheckCompleted", "CheckCompleted", "CheckCompleted", "CheckCompleted"]);
    expect(logs).toEqual(["journal: +4 events", "journal: +2 events"]);
    const [head] = await storage.listHeads(FAMILY_ID, { streams: [`check:activities-watch:${NOW_ACCOUNT}`] });
    expect(head?.payload).toEqual({ service: "activenow", sessions: 1 });
    expect(head?.day).toBe("2026-10-20");
  });

  it("stores the full state of the Session", async () => {
    const { storage, pass } = setup();
    await pass([session()]);
    const [head] = await storage.listHeads(FAMILY_ID, { kinds: ["session"] });
    expect(head?.stream).toBe(`session:${session().childId}:${session().id}`);
    expect(head?.day).toBe("2026-10-27");
    expect(head?.payload).toEqual({
      accountId: NOW_ACCOUNT, service: "activenow", activity: "Choir", start: "2026-10-27T15:00",
      end: "2026-10-27T16:00", place: "Example Hall", status: "planned", warning: null,
    });
  });

  it("types an added cancelled or moved Session", async () => {
    const { pass, types } = setup();
    await pass([session({ status: "cancelled" }), session({ id: "b", status: "moved" })]);
    expect((await types("session:")).sort()).toEqual(["SessionCancelled", "SessionMoved"]);
  });

  it("follows cancel, restore, move, other change and vanish", async () => {
    const { pass, types } = setup();
    await pass([session()]);
    await pass([session({ status: "cancelled" })]);
    await pass([session()]);
    await pass([session({ status: "moved" })]);
    await pass([session()]);
    await pass([session({ start: "2026-10-28T15:00", end: "2026-10-28T16:00" })]);
    await pass([session({ start: "2026-10-28T15:00", end: "2026-10-28T16:00", place: "Hall Two" })]);
    await pass([]);
    expect(await types("session:")).toEqual([
      "SessionScheduled", "SessionCancelled", "SessionRestored", "SessionMoved", "SessionRestored",
      "SessionMoved", "SessionChanged", "SessionVanished",
    ]);
  });

  it("gives no event and no SessionVanished for a failed Account", async () => {
    const { pass, types } = setup();
    await pass([session()], [dance()]);
    await pass(null, [dance()]);
    expect(await types("session:")).toEqual(["SessionScheduled", "SessionScheduled"]);
    expect(await types(`check:activities-watch:${NOW_ACCOUNT}`)).toEqual(["CheckCompleted"]);
  });

  it("does nothing when every Account failed", async () => {
    const { storage, pass } = setup();
    expect(await pass(null, null)).toBe(0);
    expect(await storage.listEvents(FAMILY_ID)).toEqual([]);
  });

  it("keeps a Session outside the 14-day scope", async () => {
    const { pass, types } = setup();
    const late = session({ start: "2026-11-10T15:00", end: "2026-11-10T16:00" });
    await pass([late]);
    await pass([]);
    expect(await types("session:")).toEqual(["SessionScheduled"]);
  });

  it("makes at most 2 reads and 1 append", async () => {
    const { storage, pass } = setup();
    const calls: string[] = [];
    const heads = storage.listHeads.bind(storage);
    const append = storage.appendEvents.bind(storage);
    storage.listHeads = (...args) => (calls.push("heads"), heads(...args));
    storage.appendEvents = (...args) => (calls.push("append"), append(...args));
    await pass([session()], [dance()]);
    expect(calls).toEqual(["heads", "heads", "append"]);
  });
});
