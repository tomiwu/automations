import { describe, expect, it } from "vitest";
import { checkEvent, contentHash, planEvents, projectHeads, projectStream } from "./journal.ts";
import type { Classifier, Observed } from "./journal.ts";
import { CHILD_ID, FAMILY_ID } from "./fixtures.ts";
import type { JournalEvent } from "./storage.ts";

interface State {
  room: string;
}

const classify: Classifier<State> = {
  added: () => "LessonScheduled",
  changed: (previous, next) => (previous.room === next.room ? "LessonRestored" : "LessonChanged"),
  vanished: "LessonVanished",
};

const observed = (stream: string, room: string): Observed<State> => ({
  stream,
  childId: CHILD_ID,
  kind: "lesson",
  day: "2025-01-10",
  state: { room },
});

async function head(stream: string, seq: number, room: string, eventType = "LessonScheduled"): Promise<JournalEvent> {
  return {
    familyId: FAMILY_ID,
    childId: CHILD_ID,
    stream,
    seq,
    kind: "lesson",
    day: "2025-01-10",
    eventType,
    payload: { room },
    contentHash: await contentHash({ room }),
    source: "librus-watch",
    recordedAt: new Date(`2025-01-0${seq}T10:00:00Z`),
  };
}

const plan = (heads: JournalEvent[], seen: Observed<State>[], inVanishScope = () => true) =>
  planEvents({ familyId: FAMILY_ID, source: "librus-watch", heads, observed: seen, inVanishScope, classify });

describe("contentHash", () => {
  it("is stable for the order of keys and differs for other content", async () => {
    expect(await contentHash({ a: 1, b: { c: 2, d: [1, { f: 1, e: 2 }] } })).toBe(
      await contentHash({ b: { d: [1, { e: 2, f: 1 }], c: 2 }, a: 1 }),
    );
    expect(await contentHash({ a: 1 })).not.toBe(await contentHash({ a: 2 }));
    expect(await contentHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("planEvents", () => {
  it("adds seq 1 for a stream without a head", async () => {
    const [event] = await plan([], [observed("s1", "A1")]);
    expect(event).toMatchObject({
      familyId: FAMILY_ID,
      source: "librus-watch",
      stream: "s1",
      seq: 1,
      eventType: "LessonScheduled",
      payload: { room: "A1" },
      kind: "lesson",
      day: "2025-01-10",
    });
    expect(event?.contentHash).toBe(await contentHash({ room: "A1" }));
  });

  it("gives no event for the same state", async () => {
    expect(await plan([await head("s1", 1, "A1")], [observed("s1", "A1")])).toEqual([]);
  });

  it("gives a change event with the next seq", async () => {
    const events = await plan([await head("s1", 2, "A1")], [observed("s1", "B2")]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ seq: 3, eventType: "LessonChanged", payload: { room: "B2" } });
  });

  it("writes a vanished event for a head that is gone", async () => {
    const [event] = await plan([await head("s1", 1, "A1")], []);
    expect(event).toMatchObject({ seq: 2, eventType: "LessonVanished", payload: { room: "A1" }, day: "2025-01-10" });
    expect(event?.contentHash).toBe(await contentHash({ room: "A1", vanished: true }));
  });

  it("writes no vanished event outside the scope or twice", async () => {
    expect(await plan([await head("s1", 1, "A1")], [], () => false)).toEqual([]);
    expect(await plan([await head("s1", 2, "A1", "LessonVanished")], [])).toEqual([]);
  });

  it("adds again when the stream comes back after a vanish", async () => {
    const [event] = await plan([await head("s1", 2, "A1", "LessonVanished")], [observed("s1", "A1")]);
    expect(event).toMatchObject({ seq: 3, eventType: "LessonScheduled" });
  });

  it("lets the last observed row of a stream win", async () => {
    const events = await plan([], [observed("s1", "A1"), observed("s1", "B2")]);
    expect(events.map((event) => event.payload)).toEqual([{ room: "B2" }]);
  });
});

describe("checkEvent", () => {
  const base = { familyId: FAMILY_ID, childId: CHILD_ID, stream: "check:librus-watch:c1", source: "librus-watch", day: null };

  it("starts at seq 1 and goes on from the head", async () => {
    const first = await checkEvent({ ...base, payload: { at: "t1" } });
    expect(first).toMatchObject({ seq: 1, kind: "check", eventType: "CheckCompleted", day: null });
    const next = await checkEvent({ ...base, head: { ...first, recordedAt: new Date() }, payload: { at: "t2" } });
    expect(next.seq).toBe(2);
  });
});

describe("projectStream and projectHeads", () => {
  it("folds a stream to its last state", async () => {
    const events = [await head("s1", 1, "A1"), await head("s1", 2, "B2", "LessonChanged")];
    expect(projectStream(events)).toEqual({
      stream: "s1",
      state: { room: "B2" },
      vanished: false,
      seq: 2,
      lastEventType: "LessonChanged",
      lastChanged: new Date("2025-01-02T10:00:00Z"),
    });
  });

  it("marks a vanished stream", async () => {
    const events = [await head("s1", 1, "A1"), await head("s1", 2, "A1", "LessonVanished")];
    expect(projectStream(events)).toMatchObject({ vanished: true, seq: 2 });
  });

  it("fails for an empty stream", () => {
    expect(() => projectStream([])).toThrow("no events");
  });

  it("projects heads one by one", async () => {
    const heads = [await head("s1", 1, "A1"), await head("s2", 3, "C3")];
    expect(projectHeads(heads).map((item) => [item.stream, item.seq])).toEqual([["s1", 1], ["s2", 3]]);
  });
});
