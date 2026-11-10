import { createSupabaseStorage, type NewJournalEvent } from "@automations/librus-data";
import { createFakePostgrest } from "@automations/librus-data/fake-postgrest";
import { countFetches, fakeRuntime } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { storedSessionsExport } from "./stored-sessions.ts";
import { CHILD1, CHILD2, EDUSKY_ACCOUNT, FAMILY_ID, NOW_ACCOUNT, testConfig } from "./test-fixtures.ts";

const KEY = "test-key";
const NOW = new Date("2026-10-20T08:00:00Z");

let counter = 0;
const sessionEvent = (childId: string, id: string, day: string, extra: Record<string, unknown> = {}, e: Partial<NewJournalEvent> = {}): NewJournalEvent => ({
  familyId: FAMILY_ID, childId, seq: 1, eventType: "SessionScheduled", contentHash: `h${counter++}`, source: "activities-watch",
  stream: `session:${childId}:${id}`, kind: "session", day,
  payload: {
    accountId: NOW_ACCOUNT, service: "activenow", activity: "Choir", start: `${day}T15:00`, end: `${day}T16:00`,
    place: "Example Hall", status: "planned", warning: null, ...extra,
  },
  ...e,
});

const checkEvent = (accountId: string, childId: string): NewJournalEvent => ({
  familyId: FAMILY_ID, childId, seq: 1, eventType: "CheckCompleted", contentHash: `h${counter++}`, source: "activities-watch",
  stream: `check:activities-watch:${accountId}`, kind: "check", day: "2026-10-20", payload: { service: "activenow", sessions: 1 },
});

async function setup(events: NewJournalEvent[]) {
  const server = createFakePostgrest(NOW, KEY);
  server.seedConfig(testConfig());
  const supabase = { url: "https://project.example.test", key: KEY, fetch: server.fetch, now: () => NOW };
  await createSupabaseStorage(supabase).appendEvents(events);
  const counting = countFetches(server.fetch);
  const storage = createSupabaseStorage({ ...supabase, fetch: counting.fetch });
  return { storage, runtime: fakeRuntime({ now: NOW }), familyId: FAMILY_ID, counter: counting };
}

describe("storedSessionsExport", () => {
  it("makes at most 3 Supabase fetches and no other fetch", async () => {
    const deps = await setup([sessionEvent(CHILD1, "a", "2026-10-21")]);
    const result = await storedSessionsExport(deps);
    expect(result.fetches!.total).toBeLessThanOrEqual(3);
    expect(Object.keys(result.fetches!.hosts)).toEqual(["project.example.test"]);
  });

  it("gives both Children by start, with the defaults today and 13 days", async () => {
    const deps = await setup([
      sessionEvent(CHILD1, "b", "2026-10-22"),
      sessionEvent(CHILD2, "a", "2026-10-21", { service: "edusky", activity: "Dance", accountId: EDUSKY_ACCOUNT }),
      sessionEvent(CHILD1, "old", "2026-10-19"),
      checkEvent(NOW_ACCOUNT, CHILD1),
    ]);
    const result = await storedSessionsExport(deps, {});
    expect(result).toMatchObject({ timezone: "UTC", from: "2026-10-20", to: "2026-11-02" });
    expect(result.sessions.map((s) => [s.id, s.child, s.activity])).toEqual([["a", "Child Two", "Dance"], ["b", "Child One", "Choir"]]);
    expect(result.sessions[1]).toMatchObject({ childId: CHILD1, stream: `session:${CHILD1}:b`, status: "planned", warning: null, vanished: false, seq: 1 });
    expect(result.accounts).toEqual([
      { accountId: NOW_ACCOUNT, childId: CHILD1, service: "activenow", lastSavedAt: NOW.toISOString() },
      { accountId: EDUSKY_ACCOUNT, childId: CHILD2, service: "edusky", lastSavedAt: null },
    ]);
  });

  it("filters by childId", async () => {
    const deps = await setup([sessionEvent(CHILD1, "a", "2026-10-21"), sessionEvent(CHILD2, "b", "2026-10-21")]);
    const result = await storedSessionsExport(deps, { childId: CHILD2 });
    expect(result.sessions.map((s) => s.id)).toEqual(["b"]);
    expect(result.accounts.map((a) => a.accountId)).toEqual([EDUSKY_ACCOUNT]);
  });

  it("filters by from and to", async () => {
    const deps = await setup([sessionEvent(CHILD1, "a", "2026-11-01"), sessionEvent(CHILD1, "b", "2026-11-03"), sessionEvent(CHILD1, "c", "2026-11-09")]);
    const result = await storedSessionsExport(deps, { from: "2026-11-01", to: "2026-11-05" });
    expect(result.sessions.map((s) => s.id)).toEqual(["a", "b"]);
    expect((await storedSessionsExport(deps, { from: "2026-11-01" })).to).toBe("2026-11-14");
  });

  it("keeps vanished Sessions with vanished true", async () => {
    const deps = await setup([
      sessionEvent(CHILD1, "a", "2026-10-21"),
      sessionEvent(CHILD1, "a", "2026-10-21", {}, { seq: 2, eventType: "SessionVanished" }),
      sessionEvent(CHILD1, "b", "2026-10-22", { status: "cancelled", warning: "mail differs" }, { eventType: "SessionCancelled" }),
    ]);
    const result = await storedSessionsExport(deps);
    expect(result.sessions.map((s) => [s.id, s.vanished, s.seq, s.status, s.warning])).toEqual([
      ["a", true, 2, "planned", null],
      ["b", false, 1, "cancelled", "mail differs"],
    ]);
  });

  it("gives lastSavedAt null with no check event", async () => {
    const deps = await setup([]);
    const result = await storedSessionsExport(deps);
    expect(result.sessions).toEqual([]);
    expect(result.accounts.map((a) => a.lastSavedAt)).toEqual([null, null]);
  });

  it.each([
    [{ days: 3 }, /Unknown input key/],
    [{ from: "tomorrow" }, /from must be a date/],
    [{ childId: 4 }, /childId must be a text/],
    [{ childId: "nobody" }, /Unknown child/],
    [{ from: "2026-11-05", to: "2026-11-01" }, /not be before/],
    [{ from: "2026-11-01", to: "2027-02-05" }, /at most 60 days/],
    [[], /Input must be an object/],
  ])("rejects the input %j", async (input, message) => {
    const deps = await setup([]);
    await expect(storedSessionsExport(deps, input)).rejects.toThrow(message);
  });

  it("gives the Journal child_id on each Session and Account", async () => {
    const deps = await setup([
      sessionEvent(CHILD1, "a", "2026-10-21"),
      sessionEvent(CHILD2, "b", "2026-10-22", { service: "edusky", accountId: EDUSKY_ACCOUNT }),
      sessionEvent(CHILD2, "c", "2026-10-23", {}, { stream: "session:other-key-shape:c" }),
    ]);
    const result = await storedSessionsExport(deps);
    expect(result.sessions.map((s) => [s.id, s.childId])).toEqual([["a", CHILD1], ["b", CHILD2], ["c", CHILD2]]);
    expect(result.sessions.every((s) => typeof s.childId === "string" && s.childId !== "")).toBe(true);
    expect(result.accounts.every((a) => [CHILD1, CHILD2].includes(a.childId))).toBe(true);
  });
});
