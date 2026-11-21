import { createMemoryStorage, type ItemKind, type NewItemDetail } from "@automations/librus-data";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MORNING_REPORT_UTC_HOUR, formatMorningReport, isMorningReportRun, newItemsSince, runMorningReport, type MorningReportDeps } from "./morning-report.ts";
import { CHILD1, FAMILY_ID, fakeSource, lesson, testConfig } from "./test-fixtures.ts";
import { upcoming } from "./upcoming.ts";

const child = { id: CHILD1, name: "Child One" };
const MONDAY_0430Z = new Date("2026-01-05T04:30:00Z");

function setup(now = MONDAY_0430Z) {
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
  it("is true on a weekday at 04:00 UTC hour only", () => {
    expect(isMorningReportRun(MONDAY_0430Z, "UTC")).toBe(true);
    expect(isMorningReportRun(new Date("2026-01-05T12:30:00Z"), "UTC")).toBe(false);
    expect(isMorningReportRun(new Date("2026-01-10T04:30:00Z"), "UTC")).toBe(false);
  });

  it("uses the UTC hour and the weekday of the family time zone", () => {
    expect(isMorningReportRun(MONDAY_0430Z, "Europe/Warsaw")).toBe(true);
    expect(isMorningReportRun(new Date("2026-01-05T12:30:00Z"), "Europe/Warsaw")).toBe(false);
    expect(isMorningReportRun(new Date("2026-07-06T04:30:00Z"), "Europe/Warsaw")).toBe(true);
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
    const { storage, deps } = setup(new Date("2026-01-05T12:30:00Z"));
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

const KINDS: ItemKind[] = ["meeting", "dayOff", "trip", "terminarz", "announcement", "message", "grade"];

function detailRow(kind: ItemKind, extra: Partial<NewItemDetail> = {}): NewItemDetail {
  return {
    familyId: FAMILY_ID,
    scope: `${kind}:${CHILD1}`,
    kind,
    childId: CHILD1,
    sourceId: `${kind}-1`,
    date: "2026-01-05",
    startTime: null,
    endTime: null,
    title: `Title of ${kind}`,
    text: "Body",
    sender: null,
    subject: null,
    category: null,
    sourceUpdatedAt: null,
    ...extra,
  };
}

describe("newItemsSince", () => {
  it("is 24 hours before the run, or 72 hours on Monday", () => {
    expect(newItemsSince(MONDAY_0430Z, "UTC").toISOString()).toBe("2026-01-02T04:30:00.000Z");
    expect(newItemsSince(new Date("2026-01-06T04:30:00Z"), "UTC").toISOString()).toBe("2026-01-05T04:30:00.000Z");
  });
});

describe("the New section", () => {
  async function reportText(rows: NewItemDetail[], language: "en" | "pl" = "en"): Promise<string> {
    const { storage, deps } = setup();
    await storage.recordDetails(rows);
    await runMorningReport(deps);
    const pending = await storage.pendingNotifications(FAMILY_ID);
    return (language === "en" ? pending[0] : pending[1])?.text ?? "";
  }

  it("is left out when there are no new Items", async () => {
    expect(await reportText([])).not.toContain("New:");
  });

  it("is left out when the Items are older than the window or belong to another Child", async () => {
    const old = createMemoryStorage({ now: () => new Date("2025-12-20T00:00:00Z") });
    const { deps } = setup();
    await old.recordDetails([detailRow("message")]);
    await runMorningReport({ ...deps, storage: old });
    const text = (await old.pendingNotifications(FAMILY_ID))[0]?.text ?? "";
    expect(text).not.toContain("New:");
    expect(await reportText([detailRow("message", { childId: "other" })])).not.toContain("New:");
  });

  it("has one line for each Item of each kind", async () => {
    const rows = KINDS.map((kind) =>
      kind === "grade" ? detailRow(kind, { title: "Math", text: "5" }) : detailRow(kind),
    );
    const text = await reportText(rows);
    const lines = text.slice(text.indexOf("New:")).split("\n");
    expect(lines).toEqual([
      "New:",
      "• Parent meeting, 2026-01-05: Title of meeting",
      "• Day off, 2026-01-05: Title of dayOff",
      "• Trip, 2026-01-05: Title of trip",
      "• Calendar, 2026-01-05: Title of terminarz",
      "• Announcement, 2026-01-05: Title of announcement",
      "• Message, 2026-01-05: Title of message",
      "• Grade, 2026-01-05: Math, 5",
    ]);
  });

  it("cuts a long title to one line and handles a missing date", async () => {
    const text = await reportText([
      detailRow("message", { title: `First\nsecond ${"x".repeat(100)}`, date: null }),
      detailRow("grade", { title: "Art", text: "4", date: null }),
    ]);
    expect(text).toContain(`• Message: First second ${"x".repeat(80 - "First second ".length)}…\n• Grade: Art, 4`);
  });

  it("is in Polish for a Polish Recipient", async () => {
    const text = await reportText([detailRow("trip")], "pl");
    expect(text).toContain("Nowe:\n• Wycieczka, 2026-01-05: Title of trip");
  });
});

describe("Morning report schedule", () => {
  it("runs at an hour that the package cron expression schedules", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      kody: { jobs: { "scheduled-check": { schedule: { expression: string } } } };
    };
    const hours = manifest.kody.jobs["scheduled-check"].schedule.expression.split(" ")[1]?.split(",").map(Number);
    expect(hours).toContain(MORNING_REPORT_UTC_HOUR);
  });
});
