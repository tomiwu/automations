import { createSupabaseStorage, type NewItemDetail } from "@automations/librus-data";
import { createFakePostgrest } from "@automations/librus-data/fake-postgrest";
import { exampleConfig, FAMILY_ID } from "@automations/librus-data/fixtures";
import { countFetches, fakeRuntime } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { checkDay, checkSince } from "./events.ts";
import { eventsExport } from "./exports.ts";

const SUPABASE = "https://project.example.test";
const KEY = "test-key";

function detail(childId: string, sourceId: string, extra: Partial<NewItemDetail> = {}): NewItemDetail {
  return {
    familyId: FAMILY_ID, scope: `x:${childId}`, kind: "announcement", childId, sourceId, date: null,
    startTime: null, endTime: null, title: "Title", text: "Text", sender: null, subject: null, category: null,
    sourceUpdatedAt: null, ...extra,
  };
}

async function setup(rows: (now: Date) => NewItemDetail[] = () => []) {
  const now = new Date("2026-01-10T23:30:00Z");
  const server = createFakePostgrest(now, KEY);
  server.seedConfig(exampleConfig());
  const config = exampleConfig();
  const childId = config.children[0]!.id;
  const supabase = { url: SUPABASE, key: KEY, fetch: server.fetch, now: () => now };
  await createSupabaseStorage(supabase).recordDetails(rows(now).map((row) => ({ ...row, childId: row.childId || childId })));
  const counter = countFetches(server.fetch);
  const storage = createSupabaseStorage({ ...supabase, fetch: counter.fetch });
  const runtime = { ...fakeRuntime({ now }), fetch: counter.fetch };
  return { deps: { runtime, storage, familyId: FAMILY_ID, counter }, childId, config };
}

describe("eventsExport", () => {
  it("makes at most 2 Supabase fetches and no Librus fetch", async () => {
    const { deps } = await setup(() => [detail("", "1")]);
    const result = await eventsExport(deps, {});
    expect(result.fetches?.total).toBe(2);
    expect(Object.keys(result.fetches?.hosts ?? {})).toEqual(["project.example.test"]);
  });

  it("returns the whole text and the event fields", async () => {
    const text = "long ".repeat(2000);
    const { deps, childId } = await setup(() => [
      detail("", "1", { kind: "dayOff", date: "2026-02-02", title: "Break", text: `Break\n2026-02-02 - 2026-02-06` }),
      detail("", "2", { kind: "meeting", date: "2026-02-03", startTime: "17:00", endTime: "17:30", text, sender: "Teacher One" }),
    ]);
    const result = await eventsExport(deps, { since: "2026-01-01T00:00:00Z" });
    expect(result).toMatchObject({ childId, child: "Child One", from: null, to: null, since: "2026-01-01T00:00:00.000Z" });
    const [dayOff, meeting] = result.events;
    expect(dayOff).toMatchObject({ kind: "dayOff", date: "2026-02-02", endDate: "2026-02-06", start: null });
    expect(dayOff!.id).toMatch(/^dayOff:1@[0-9a-f]{64}$/);
    expect(meeting).toMatchObject({ kind: "meeting", endDate: null, start: "17:00", end: "17:30", sender: "Teacher One" });
    expect(meeting!.text).toBe(text);
  });

  it("gives a stable id and a new id for changed content", async () => {
    const one = await eventsExport((await setup(() => [detail("", "1")])).deps, {});
    const two = await eventsExport((await setup(() => [detail("", "1")])).deps, {});
    const three = await eventsExport((await setup(() => [detail("", "1", { text: "Other" })])).deps, {});
    expect(two.events[0]!.id).toBe(one.events[0]!.id);
    expect(three.events[0]!.id).not.toBe(one.events[0]!.id);
  });

  it("uses the local day of firstSeen for an announcement and a message without a date", async () => {
    const { deps, config } = await setup(() => [
      detail("", "1"),
      detail("", "2", { kind: "message" }),
      detail("", "3", { kind: "terminarz" }),
    ]);
    config.family.timezone = "Europe/Warsaw";
    const storage = { ...deps.storage, loadConfig: async () => config };
    const result = await eventsExport({ ...deps, storage }, {});
    expect(result.events.map((event) => event.date)).toEqual([null, "2026-01-11", "2026-01-11"]);
  });

  it("filters by childId, from, to and since", async () => {
    const other = "00000000-0000-4000-8000-0000000000c2";
    const { deps, childId } = await setup((now) => [
      detail("", "a", { date: "2026-02-01" }),
      detail("", "b", { date: "2026-02-10" }),
      detail("", "c", { date: "2026-02-20" }),
      detail(other, "d", { date: "2026-02-10" }),
      { ...detail("", "e"), sourceUpdatedAt: now },
    ]);
    const ids = async (input: object) => (await eventsExport(deps, input)).events.map((event) => event.id.split("@")[0]);
    expect(await ids({ childId })).toEqual(["announcement:e", "announcement:a", "announcement:b", "announcement:c"]);
    expect(await ids({ from: "2026-02-05", to: "2026-02-15" })).toEqual(["announcement:b"]);
    expect(await ids({ from: "2026-02-05" })).toEqual(["announcement:b", "announcement:c"]);
    expect(await ids({ to: "2026-02-05" })).toEqual(["announcement:a"]);
    expect(await ids({ since: "2026-01-11T00:00:00Z" })).toEqual([]);
    expect(await ids({})).toHaveLength(4);
  });

  it("rejects a bad input", async () => {
    const { deps } = await setup();
    await expect(eventsExport(deps, { x: 1 })).rejects.toThrow("Unknown input key(s): x.");
    await expect(eventsExport(deps, { from: "2026-13-40" })).rejects.toThrow("from must be a date YYYY-MM-DD.");
    await expect(eventsExport(deps, { to: 5 })).rejects.toThrow("to must be a date YYYY-MM-DD.");
    await expect(eventsExport(deps, { since: "soon" })).rejects.toThrow("since must be an ISO time.");
    await expect(eventsExport(deps, { since: 5 })).rejects.toThrow("since must be an ISO time.");
    await expect(eventsExport(deps, { childId: "other" })).rejects.toThrow("Unknown child: other.");
  });

  it("checks days and since", () => {
    expect(checkDay("from", undefined)).toBeUndefined();
    expect(checkSince(undefined, new Date("2026-01-10T00:00:00Z")).toISOString()).toBe("2026-01-03T00:00:00.000Z");
  });
});
