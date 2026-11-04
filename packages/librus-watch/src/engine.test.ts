import { createMemoryStorage } from "@automations/librus-data";
import { describe, expect, it } from "vitest";
import { runChildCheck, scopeOf, type ChildCheck } from "./engine.ts";
import { CHILD1, FAMILY_ID, fakeSource, lesson, testConfig } from "./test-fixtures.ts";

function setup() {
  const config = testConfig();
  const storage = createMemoryStorage({ configs: [config] });
  const source = fakeSource();
  const child = config.children[0]!;
  const check: ChildCheck = {
    familyId: FAMILY_ID,
    child,
    recipients: config.recipients.filter((r) => r.child_ids.includes(CHILD1)),
    storage,
    source,
  };
  const texts = async () => (await storage.pendingNotifications(FAMILY_ID)).map((e) => `${e.chatId}|${e.text}`);
  return { storage, source, check, texts };
}

describe("runChildCheck", () => {
  it("records a silent Baseline on the first run", async () => {
    const { source, check, texts } = setup();
    source.items.grades = [{ id: "1", subject: "Math", grade: "5" }];
    expect(await runChildCheck(check)).toEqual([]);
    expect(await texts()).toEqual([]);
  });

  it("marks an empty scope as baselined", async () => {
    const { source, check, texts, storage } = setup();
    await runChildCheck(check);
    source.items.grades = [{ id: "1", subject: "Math", grade: "5" }];
    await runChildCheck(check);
    expect(await texts()).toHaveLength(2);
    expect((await storage.knownItemIds(FAMILY_ID, scopeOf("grades", check.child))).has("1")).toBe(true);
  });

  it("renders each Notification in the language of its Recipient and only for the Recipients of the Child", async () => {
    const { source, check, texts } = setup();
    await runChildCheck(check);
    source.items.grades = [{ id: "1", subject: "Math", grade: "5" }];
    await runChildCheck(check);
    expect(await texts()).toEqual([
      "1000001|New grade for Child One: Math, 5",
      "1000002|Nowa ocena dla Child One: Math, 5",
    ]);
  });

  it("does not repeat a Notification on the next run", async () => {
    const { source, check, texts } = setup();
    await runChildCheck(check);
    source.items.grades = [{ id: "1", subject: "Math", grade: "5" }];
    await runChildCheck(check);
    await runChildCheck(check);
    expect(await texts()).toHaveLength(2);
  });

  it("opens a message body only for a new message", async () => {
    const { source, check, texts } = setup();
    source.items.messages = [{ id: "m1", sender: "Teacher One", subject: "Hello", sentAt: "2026-01-05" }];
    await runChildCheck(check);
    expect(source.bodies).toEqual([]);
    source.items.messages = [...source.items.messages, { id: "m2", sender: "Teacher Two", subject: "Trip", sentAt: "2026-01-06" }];
    await runChildCheck(check);
    expect(source.bodies).toEqual(["m2"]);
    expect((await texts())[0]).toBe("1000001|New message for Child One from Teacher Two: Trip\nBody of m2");
  });

  it("reports an updated homework entry once", async () => {
    const { source, check, texts } = setup();
    const entry = { id: "h1", hash: "a", category: "Test", date: "2026-01-09", content: "Chapter 1", subject: "Math", teacher: "Teacher One" };
    source.items.homework = [entry];
    await runChildCheck(check);
    source.items.homework = [{ ...entry, hash: "b", content: "Chapter 2" }];
    await runChildCheck(check);
    await runChildCheck(check);
    const all = await texts();
    expect(all).toHaveLength(2);
    expect(all[0]).toBe("1000001|Updated Test for Child One, 2026-01-09: Math (Teacher One)\nChapter 2");
  });

  it("groups new substitutions of one day in one Notification", async () => {
    const { source, check, texts } = setup();
    await runChildCheck(check);
    const base = { date: "2026-01-09", orgSubject: "Math", orgTeacher: "Teacher One", subject: "Art", teacher: "Teacher Two", classroom: "5", cancelled: false };
    source.items.substitutions = [
      { ...base, id: "s2", lessonNo: "2" },
      { ...base, id: "s1", lessonNo: "1", cancelled: true },
    ];
    await runChildCheck(check);
    expect((await texts())[0]).toBe(
      "1000001|New substitutions for Child One, 2026-01-09:\n1. Math (Teacher One) - cancelled\n2. Math -> Art (Teacher One -> Teacher Two), room 5",
    );
  });

  it("announces a Lesson only when it changes to cancelled or substituted", async () => {
    const { source, check, texts } = setup();
    source.lessons = [lesson("2026-01-09", 1, "Math"), lesson("2026-01-09", 2, "Art")];
    const items = () =>
      source.lessons.map((l) => ({ ...l, id: `${l.date}:${l.period}`, hash: `${l.status}|${l.substituteTeacher}` }));
    source.items.lessons = items();
    await runChildCheck(check);
    source.lessons = [
      lesson("2026-01-09", 1, "Math", { status: "cancelled" }),
      lesson("2026-01-09", 2, "Art", { status: "substitution", substituteTeacher: "Teacher Two" }),
      lesson("2026-01-09", 3, "Music"),
    ];
    source.items.lessons = items();
    await runChildCheck(check);
    const all = await texts();
    expect(all).toHaveLength(4);
    expect(all[0]).toBe("1000001|Lesson cancelled for Child One, 2026-01-09: 1. Math (08:00-08:45)");
    expect(all[2]).toBe("1000001|Substitution for Child One, 2026-01-09: 2. Art (09:00-09:45), Teacher Two instead of Teacher One");
  });

  it("formats trips, absences and announcements", async () => {
    const { source, check, texts } = setup();
    await runChildCheck(check);
    source.items.trips = [{ id: "t1", destination: "Museum", route: "Town", transport: "", from: "2026-01-09", to: "2026-01-10", coordinator: "Teacher One" }];
    source.items.absences = [{ id: "a1", hash: "x", teacher: "Teacher One", from: "2026-01-09", to: "2026-01-09", timeFrom: "08:00", timeTo: "10:00", addedAt: "2026-01-08" }];
    source.items.announcements = [{ id: "n1", title: "Notice", summary: "Line one\nLine two", text: "Line one\nLine two", publishedAt: "2026-01-05 10:30:00" }];
    await runChildCheck(check);
    const all = (await texts()).filter((t) => t.startsWith("1000001"));
    expect(all).toContain("1000001|New trip for Child One, 2026-01-09 - 2026-01-10: Museum\nRoute: Town\nCoordinator: Teacher One");
    expect(all).toContain("1000001|New absence for Child One: Teacher One, 2026-01-09, 08:00-10:00\nAdded 2026-01-08");
    expect(all).toContain("1000001|New announcement for Child One: Notice\nLine one");
  });

  it("isolates a failing Watcher", async () => {
    const { source, check } = setup();
    source.currentItems = async (watcher) => {
      if (watcher === "grades") throw new Error("boom");
      return [] as never;
    };
    const lines: string[] = [];
    const failures = await runChildCheck({ ...check, log: (m) => lines.push(m) });
    expect(failures).toEqual(["grades: boom"]);
    expect(lines).toContain("watcher messages: ok");
    expect(lines).toContain("watcher grades: fail");
  });

  it("keeps Items of two Children apart", async () => {
    const { check, source, storage } = setup();
    source.items.grades = [{ id: "1", subject: "Math", grade: "5" }];
    await runChildCheck(check);
    const other = { ...check.child, id: "other" };
    expect((await storage.knownItemIds(FAMILY_ID, scopeOf("grades", other))).size).toBe(0);
  });

  describe("stored content", () => {
    const details = (storage: ReturnType<typeof setup>["storage"]) => storage.listDetails(FAMILY_ID);

    it("stores the whole body of a new message once and opens it once", async () => {
      const { source, check, storage } = setup();
      source.items.messages = [{ id: "m1", sender: "Teacher One", subject: "Hello", sentAt: "2026-01-05 10:30:00" }];
      await runChildCheck(check);
      source.items.messages = [...source.items.messages, { id: "m2", sender: "Teacher Two", subject: "Trip", sentAt: "2026-01-06 08:00:00" }];
      await runChildCheck(check);
      await runChildCheck(check);
      expect(source.bodies).toEqual(["m2"]);
      const rows = await details(storage);
      expect(rows.map((r) => [r.kind, r.sourceId, r.text])).toEqual([["message", "m2", "Body of m2"]]);
    });

    it("stores no detail in the Baseline run", async () => {
      const { source, check, storage } = setup();
      source.items.messages = [{ id: "m1", sender: "Teacher One", subject: "Hello", sentAt: "2026-01-05" }];
      source.items.trips = [{ id: "t1", destination: "Museum", route: "", transport: "", from: "2026-02-01", to: "2026-02-01", coordinator: "" }];
      await runChildCheck(check);
      expect(await details(storage)).toEqual([]);
    });

    it("adds a row for an updated Terminarz entry and keeps the old row", async () => {
      const { source, check, storage } = setup();
      await runChildCheck(check);
      const entry = { id: "h1", hash: "a", category: "Test", date: "2026-01-09", content: "Chapter 1", subject: "Math", teacher: "Teacher One" };
      source.items.homework = [entry];
      await runChildCheck(check);
      source.items.homework = [{ ...entry, hash: "b", content: "Chapter 2" }];
      await runChildCheck(check);
      expect((await details(storage)).map((r) => r.text)).toEqual(["Chapter 1", "Chapter 2"]);
    });

    it("stores announcements and trips", async () => {
      const { source, check, storage } = setup();
      await runChildCheck(check);
      source.items.announcements = [{ id: "n1", title: "Notice", summary: "Sh", text: "Whole text", publishedAt: "2026-01-05" }];
      source.items.trips = [{ id: "t1", destination: "Museum", route: "A", transport: "Bus", from: "2026-02-01", to: "2026-02-02", coordinator: "Teacher One" }];
      await runChildCheck(check);
      expect((await details(storage)).map((r) => r.kind).sort()).toEqual(["announcement", "trip"]);
    });
  });

  describe("meetings and days off", () => {
    const meeting = (date: string) => ({ id: "m1", hash: `h-${date}`, date, start: "17:00", end: "", topic: "Open day", room: "5", teacher: "Teacher One" });

    it("stores a changed meeting as a new detail row and sends no Notification", async () => {
      const { source, check, texts, storage } = setup();
      source.items.meetings = [meeting("2026-01-20")];
      await runChildCheck(check, ["meetings"]);
      source.items.meetings = [meeting("2026-01-21")];
      expect(await runChildCheck(check, ["meetings"])).toEqual([]);
      expect(await texts()).toEqual([]);
      const rows = await storage.listDetails(FAMILY_ID, { childId: CHILD1 });
      expect(rows.map((r) => [r.kind, r.sourceId, r.date])).toEqual([["meeting", "m1", "2026-01-21"]]);
    });

    it("stores new days off with the kind dayOff after a silent Baseline", async () => {
      const { source, check, texts, storage } = setup();
      await runChildCheck(check, ["schoolFreeDays", "classFreeDays"]);
      source.items.schoolFreeDays = [{ id: "1", hash: "a", from: "2026-02-10", to: "2026-02-14", name: "Break" }];
      source.items.classFreeDays = [{ id: "2", hash: "b", from: "2026-03-02", to: "2026-03-02", name: "Trip day" }];
      await runChildCheck(check, ["schoolFreeDays", "classFreeDays"]);
      expect(await texts()).toEqual([]);
      const rows = await storage.listDetails(FAMILY_ID, { childId: CHILD1 });
      expect(rows.map((r) => [r.kind, r.sourceId]).sort()).toEqual([["dayOff", "1"], ["dayOff", "2"]]);
    });

    it("fails only the watcher whose endpoint fails", async () => {
      const { source, check } = setup();
      const original = source.currentItems.bind(source);
      source.currentItems = (async (watcher: never, since?: string) => {
        if (watcher === "meetings") throw new Error("HTTP 500");
        return original(watcher, since);
      }) as never;
      expect(await runChildCheck(check, ["meetings", "schoolFreeDays", "classFreeDays"])).toEqual(["meetings: HTTP 500"]);
    });
  });
});
