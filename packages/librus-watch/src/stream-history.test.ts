import { createSupabaseStorage, type NewJournalEvent } from "@automations/librus-data";
import { createFakePostgrest } from "@automations/librus-data/fake-postgrest";
import { exampleConfig, FAMILY_ID } from "@automations/librus-data/fixtures";
import { countFetches, fakeRuntime } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { streamHistoryExport } from "./stream-history.ts";

const SUPABASE = "https://project.example.test";
const KEY = "test-key";
const NOW = new Date("2026-01-10T10:00:00Z");
const STREAM = "lesson:child-1:2026-01-10:1";

const event = (e: Partial<NewJournalEvent>): NewJournalEvent => ({
  familyId: FAMILY_ID, childId: exampleConfig().children[0]!.id, stream: STREAM, kind: "lesson", seq: 1, day: "2026-01-10",
  eventType: "LessonScheduled", contentHash: "h1", source: "librus-watch", payload: { subject: "Math" }, ...e,
});

async function setup(events: NewJournalEvent[]) {
  const server = createFakePostgrest(NOW, KEY);
  server.seedConfig(exampleConfig());
  const supabase = { url: SUPABASE, key: KEY, fetch: server.fetch, now: () => NOW };
  await createSupabaseStorage(supabase).appendEvents(events);
  const counting = countFetches(server.fetch);
  const storage = createSupabaseStorage({ ...supabase, fetch: counting.fetch });
  const runtime = { ...fakeRuntime({ now: NOW }), fetch: counting.fetch };
  return { storage, runtime, familyId: FAMILY_ID, counter: counting };
}

describe("streamHistoryExport", () => {
  it("gives the events oldest first and the projected state, with 1 Supabase fetch", async () => {
    const deps = await setup([
      event({ seq: 2, eventType: "LessonChanged", contentHash: "h2", payload: { subject: "Art" } }),
      event({ seq: 1 }),
      event({ stream: "lesson:child-1:2026-01-10:2", contentHash: "h3" }),
    ]);
    const result = await streamHistoryExport(deps, { stream: STREAM });
    expect(result.stream).toBe(STREAM);
    expect(result.events.map((e) => [e.seq, e.eventType, e.kind, e.day, e.contentHash])).toEqual([
      [1, "LessonScheduled", "lesson", "2026-01-10", "h1"],
      [2, "LessonChanged", "lesson", "2026-01-10", "h2"],
    ]);
    expect(result.events[1]).toMatchObject({ recordedAt: NOW.toISOString(), payload: { subject: "Art" } });
    expect(result.state).toEqual({ state: { subject: "Art" }, vanished: false, seq: 2, lastEventType: "LessonChanged", lastChanged: NOW.toISOString() });
    expect(result.fetches!.total).toBe(1);
    expect(Object.keys(result.fetches!.hosts)).toEqual(["project.example.test"]);
  });

  it("marks a vanished stream", async () => {
    const deps = await setup([event({}), event({ seq: 2, eventType: "LessonVanished", contentHash: "h2" })]);
    expect((await streamHistoryExport(deps, { stream: STREAM })).state).toMatchObject({ vanished: true, seq: 2 });
  });

  it("gives no events and a null state for an unknown stream", async () => {
    const deps = await setup([event({})]);
    const result = await streamHistoryExport(deps, { stream: "lesson:nobody" });
    expect(result).toMatchObject({ stream: "lesson:nobody", events: [], state: null });
    expect(result.fetches!.total).toBe(1);
  });

  it.each([
    [{}, /stream must be a text/],
    [{ stream: 4 }, /stream must be a text/],
    [{ stream: "" }, /stream must be a text/],
    [{ stream: "x".repeat(301) }, /at most 300/],
    [{ stream: STREAM, extra: 1 }, /Unknown input key/],
    [[], /Input must be an object/],
  ])("rejects the input %j", async (input, message) => {
    const deps = await setup([]);
    await expect(streamHistoryExport(deps, input)).rejects.toThrow(message);
  });
});
