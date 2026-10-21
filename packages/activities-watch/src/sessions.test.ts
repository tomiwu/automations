import { describe, expect, it } from "vitest";
import { statusOf as activeNowStatus, toSession as activeNowSession } from "./activenow-sessions.ts";
import { inGroup, statusOf as eduskyStatus, toSession as eduskySession, type EduskyItem } from "./edusky-sessions.ts";
import { inWindow, makeSession, timeRange, toItem } from "./sessions.ts";
import { ACTIVITY1, choirActivity, danceActivity, session, testConfig } from "./test-fixtures.ts";
import type { ActiveNowEvent } from "./activenow-parse.ts";

const child = testConfig().children[0]!;

const event = (extra: Partial<ActiveNowEvent> = {}): ActiveNowEvent => ({
  date: "2026-10-27",
  from: "15:00",
  to: "16:00",
  title: "Group Blue",
  place: "Example Hall",
  struckOut: false,
  badges: [],
  ...extra,
});

const item = (extra: Partial<EduskyItem> = {}): EduskyItem => ({
  start: "2026-10-27T16:00",
  end: "2026-10-27T17:00",
  courseGroup: "Group Blue / Example School",
  titleRoom: "Room 5",
  cancel: 0,
  idActivityShifted: null,
  dateBeforeShifted: "",
  ...extra,
});

describe("ActiveNow status", () => {
  it("is planned for a plain card", () => expect(activeNowStatus(event())).toBe("planned"));
  it("is cancelled for a cancel chip", () => {
    expect(activeNowStatus(event({ badges: ["Zajęcia odwołane"] }))).toBe("cancelled");
    expect(activeNowStatus(event({ badges: ["Anulowane"] }))).toBe("cancelled");
  });
  it("is cancelled for a struck-out date, but not when a parent reported an absence", () => {
    expect(activeNowStatus(event({ struckOut: true }))).toBe("cancelled");
    expect(activeNowStatus(event({ struckOut: true, badges: ["Zgłoszona nieobecność"] }))).toBe("planned");
  });
  it("is moved for an old day or a chip", () => {
    expect(activeNowStatus(event({ originalDate: "2026-10-26" }))).toBe("moved");
    expect(activeNowStatus(event({ badges: ["Zmieniony termin"] }))).toBe("moved");
  });
});

describe("ActiveNow session", () => {
  it("uses the day before a move in the ID, so a move updates the Item", () => {
    const moved = activeNowSession(event({ date: "2026-10-28", originalDate: "2026-10-27" }), child, choirActivity);
    expect(moved.id).toBe(`${ACTIVITY1}:2026-10-27:15:00`);
    expect(moved.start).toBe("2026-10-28T15:00");
    expect(moved.status).toBe("moved");
    expect(moved.activity).toBe("Choir");
    expect(moved.child).toBe("Child One");
  });

  it("takes the place of the Activity when the app gives none", () => {
    expect(activeNowSession(event({ place: "" }), child, choirActivity).place).toBe("Example Hall");
    expect(activeNowSession(event({ place: "" }), child, { ...choirActivity, place: null }).place).toBe("");
  });
});

describe("Edusky", () => {
  it("reads the status of an item", () => {
    expect(eduskyStatus(item())).toBe("planned");
    expect(eduskyStatus(item({ cancel: 1 }))).toBe("cancelled");
    expect(eduskyStatus(item({ cancel: "1" }))).toBe("cancelled");
    expect(eduskyStatus(item({ idActivityShifted: 5 }))).toBe("moved");
    expect(eduskyStatus(item({ dateBeforeShifted: "2026-10-26 16:00:00" }))).toBe("moved");
  });

  it("matches the group of the Account", () => {
    expect(inGroup(item(), "Group Blue")).toBe(true);
    expect(inGroup(item(), "Group Red")).toBe(false);
    expect(inGroup(item(), null)).toBe(true);
  });

  it("uses the day before a move in the ID", () => {
    const moved = eduskySession(item({ dateBeforeShifted: "2026-10-26 16:00:00" }), child, danceActivity);
    expect(moved.id).toBe(`${danceActivity.id}:2026-10-26:16:00`);
    expect(moved.place).toBe("Room 5");
    expect(moved.service).toBe("edusky");
  });
});

describe("Session helpers", () => {
  it("has an Item hash that changes with status, time and place", () => {
    const base = toItem(session());
    expect(toItem(session()).hash).toBe(base.hash);
    expect(toItem(session({ status: "cancelled" })).hash).not.toBe(base.hash);
    expect(toItem(session({ start: "2026-10-27T15:30" })).hash).not.toBe(base.hash);
    expect(toItem(session({ place: "Other" })).hash).not.toBe(base.hash);
  });

  it("keeps the window to 14 days, today included", () => {
    expect(inWindow(session({ start: "2026-10-20T15:00" }), "2026-10-20")).toBe(true);
    expect(inWindow(session({ start: "2026-11-02T15:00" }), "2026-10-20")).toBe(true);
    expect(inWindow(session({ start: "2026-11-03T15:00" }), "2026-10-20")).toBe(false);
    expect(inWindow(session({ start: "2026-10-19T15:00" }), "2026-10-20")).toBe(false);
  });

  it("formats the time range", () => {
    expect(timeRange(session())).toBe("15:00-16:00");
  });

  it("makes a Session with the ID of the Activity", () => {
    const made = makeSession(child, choirActivity, "activenow", {
      start: "a",
      end: "b",
      place: "",
      status: "planned",
      idDay: "d",
      idTime: "t",
    });
    expect(made.id).toBe(`${ACTIVITY1}:d:t`);
  });
});
