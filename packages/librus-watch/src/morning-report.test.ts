import { createMemoryStorage } from "@automations/librus-data";
import { describe, expect, it } from "vitest";
import { formatMorningReport, isMorningReportRun, runMorningReport, type MorningReportDeps } from "./morning-report.ts";
import { CHILD1, FAMILY_ID, fakeSource, lesson, testConfig } from "./test-fixtures.ts";
import { upcoming } from "./upcoming.ts";

const child = { id: CHILD1, name: "Child One" };
const MONDAY_7 = new Date("2026-01-05T07:10:00Z");

function setup(now = MONDAY_7) {
  const config = testConfig();
  const storage = createMemoryStorage();
  const source = fakeSource();
  source.lessons = [lesson("2026-01-05", 2, "Art", { status: "cancelled" }), lesson("2026-01-05", 1, "Math")];
  source.items.homework = [
    { id: "1", hash: "a", category: "Test", date: "2026-01-05", content: "Ch 1", subject: "Math", teacher: "" },
    { id: "2", hash: "a", category: "", date: "2026-01-06", content: "", subject: "", teacher: "" },
    { id: "3", hash: "a", category: "Homework", date: "2026-01-08", content: "x".repeat(250), subject: "Art", teacher: "" },
  ];
  const deps: MorningReportDeps = {
    storage,
    familyId: FAMILY_ID,
    child,
    recipients: config.recipients.filter((r) => r.child_ids.includes(CHILD1)),
    source,
    timezone: "UTC",
    now,
  };
  return { storage, source, deps };
}

describe("formatMorningReport", () => {
  it("renders the report in English", async () => {
    const { source } = setup();
    const data = await upcoming(source, { child, from: "2026-01-05", days: 8 });
    const text = formatMorningReport("en", "Child One", "2026-01-05", data);
    expect(text).toContain("Morning report for Child One, Monday 05.01");
    expect(text).toContain("1. 08:00-08:45 Math\n2. 09:00-09:45 Art (cancelled)");
    expect(text).toContain("Due today:\n• 08:00-08:45 Test: Math - Ch 1");
    expect(text).toContain("Due tomorrow:\n• all day entry: (no subject)");
    expect(text).toContain("Coming up:\nThursday 08.01:\n• all day Homework: Art - " + "x".repeat(200) + "…");
  });

  it("renders the report in Polish", async () => {
    const { source } = setup();
    const data = await upcoming(source, { child, from: "2026-01-05", days: 8 });
    const text = formatMorningReport("pl", "Child One", "2026-01-05", data);
    expect(text).toContain("Raport poranny dla Child One, poniedziałek 05.01");
    expect(text).toContain("(odwołana)");
    expect(text).toContain("cały dzień wpis: (bez przedmiotu)");
  });

  it("says when there is nothing and when the timetable is missing", async () => {
    const source = fakeSource();
    source.timetableError = "down";
    const data = await upcoming(source, { child, from: "2026-01-05", days: 8 });
    const text = formatMorningReport("en", "Child One", "2026-01-05", data);
    expect(text).toContain("The timetable could not be fetched.");
    expect(text).toContain("Nothing recorded.");
    expect(text).toContain("Timetable not available.");
    const ok = await upcoming(fakeSource(), { child, from: "2026-01-05", days: 8 });
    expect(formatMorningReport("en", "Child One", "2026-01-05", ok)).toContain("No lessons today.");
  });
});

describe("isMorningReportRun", () => {
  it("is true on a weekday at 07:00 local time only", () => {
    expect(isMorningReportRun(MONDAY_7, "UTC")).toBe(true);
    expect(isMorningReportRun(new Date("2026-01-05T18:00:00Z"), "UTC")).toBe(false);
    expect(isMorningReportRun(new Date("2026-01-10T07:00:00Z"), "UTC")).toBe(false);
    expect(isMorningReportRun(MONDAY_7, "America/New_York")).toBe(false);
  });
});

describe("runMorningReport", () => {
  it("queues one report for each Recipient of the Child, in the language of the Recipient", async () => {
    const { storage, deps } = setup();
    expect(await runMorningReport(deps)).toBe(true);
    const pending = await storage.pendingNotifications(FAMILY_ID);
    expect(pending.map((e) => e.key)).toEqual([`report:${CHILD1}:2026-01-05:1000001`, `report:${CHILD1}:2026-01-05:1000002`]);
    expect(pending[0]?.text).toContain("Morning report for");
    expect(pending[1]?.text).toContain("Raport poranny dla");
    await runMorningReport(deps);
    expect(await storage.pendingNotifications(FAMILY_ID)).toHaveLength(2);
  });

  it("does nothing outside a report run", async () => {
    const { storage, deps } = setup(new Date("2026-01-05T18:00:00Z"));
    expect(await runMorningReport(deps)).toBe(false);
    expect(await storage.pendingNotifications(FAMILY_ID)).toEqual([]);
  });

  it("adds the after-school section in the language of the Recipient", async () => {
    const { storage, deps } = setup();
    await runMorningReport({ ...deps, afterSchool: async (_c, day, language) => `After ${day} ${language}` });
    const texts = (await storage.pendingNotifications(FAMILY_ID)).map((e) => e.text);
    expect(texts[0]).toMatch(/\n\nAfter 2026-01-05 en$/);
    expect(texts[1]).toMatch(/\n\nAfter 2026-01-05 pl$/);
  });

  it("adds a short failure line when the after-school source fails", async () => {
    const { storage, deps } = setup();
    const lines: string[] = [];
    await runMorningReport({
      ...deps,
      log: (l) => lines.push(l),
      afterSchool: async () => {
        throw new Error("down");
      },
    });
    const texts = (await storage.pendingNotifications(FAMILY_ID)).map((e) => e.text);
    expect(texts[0]).toContain("After school: the activities could not be fetched.");
    expect(texts[1]).toContain("Po szkole: nie udało się pobrać zajęć.");
    expect(lines[0]).toBe("after-school section failed: down");
  });
});
