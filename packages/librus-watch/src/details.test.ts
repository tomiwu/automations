import { describe, expect, it } from "vitest";
import { announcementDetail, dayOffDetail, detailOf, meetingDetail, messageDetail, terminarzDetail, tripDetail } from "./details.ts";

const context = { familyId: "f1", scope: "x:c1", childId: "c1" };

describe("detail mapping", () => {
  it("maps a message with the whole body", () => {
    const detail = messageDetail(context, { id: "m1", sender: "Teacher One", subject: "Hello", sentAt: "2026-01-05 10:30:00" }, "Whole\nbody");
    expect(detail).toMatchObject({
      kind: "message",
      sourceId: "m1",
      date: "2026-01-05",
      title: "Hello",
      text: "Whole\nbody",
      sender: "Teacher One",
      subject: "Hello",
    });
    expect(detail.sourceUpdatedAt?.toISOString()).toBe("2026-01-05T10:30:00.000Z");
  });

  it("keeps a null time when the send date is not a date", () => {
    const detail = messageDetail(context, { id: "m1", sender: "", subject: "S", sentAt: "yesterday" }, "");
    expect(detail.date).toBeNull();
    expect(detail.sourceUpdatedAt).toBeNull();
  });

  it("maps an announcement with the whole text", () => {
    const detail = announcementDetail(context, { id: "n1", title: "Notice", summary: "Sh…", text: "Long text", publishedAt: "2026-01-05" });
    expect(detail).toMatchObject({ kind: "announcement", title: "Notice", text: "Long text", date: "2026-01-05" });
    expect(detail.sourceUpdatedAt?.toISOString()).toBe("2026-01-05T00:00:00.000Z");
  });

  it("maps a trip", () => {
    const detail = tripDetail(context, {
      id: "t1", destination: "Museum", route: "A - B", transport: "Bus", from: "2026-02-01", to: "2026-02-03", coordinator: "Teacher One",
    });
    expect(detail).toMatchObject({ kind: "trip", date: "2026-02-01", title: "Museum", sender: "Teacher One" });
    expect(detail.text).toBe("2026-02-01 - 2026-02-03\nMuseum\nA - B\nBus\nTeacher One");
  });

  it("maps a Terminarz entry", () => {
    const detail = terminarzDetail(context, {
      id: "h1", hash: "a", category: "Test", date: "2026-01-09", content: "Chapter 1", subject: "Math", teacher: "Teacher One",
    });
    expect(detail).toMatchObject({ kind: "terminarz", date: "2026-01-09", category: "Test", subject: "Math", sender: "Teacher One", text: "Chapter 1" });
  });

  it("uses nulls for empty Terminarz fields", () => {
    const detail = terminarzDetail(context, { id: "h2", hash: "a", category: "", date: "", content: "", subject: "", teacher: "" });
    expect(detail).toMatchObject({ date: null, sender: null, subject: null, category: null, title: "" });
  });

  it("gives the content of a grade", () => {
    const grade = { id: "1", subject: "Math", grade: "5", date: "2026-01-05", category: "Test", teacher: "Teacher One" };
    expect(detailOf("grades", context, grade)).toMatchObject({ kind: "grade", sourceId: "1", date: "2026-01-05", subject: "Math", category: "Test", sender: "Teacher One", title: "Math", text: "5" });
  });

  it("gives empty fields as null for a grade", () => {
    const grade = { id: "1", subject: "Math", grade: "5", date: "", category: "", teacher: "" };
    expect(detailOf("grades", context, grade)).toMatchObject({ date: null, category: null, sender: null });
  });

  it("maps a meeting and a day off", () => {
    const meeting = meetingDetail(context, { id: "m1", hash: "h", date: "2026-02-03", start: "17:00", end: "", topic: "Open day", room: "5", teacher: "Teacher One" });
    expect(meeting).toMatchObject({ kind: "meeting", date: "2026-02-03", startTime: "17:00", endTime: null, title: "Open day", sender: "Teacher One" });
    expect(meeting.text).toBe("Open day\n5\nTeacher One");
    const dayOff = dayOffDetail(context, { id: "d1", hash: "h", from: "2026-02-10", to: "2026-02-14", name: "Break" });
    expect(dayOff).toMatchObject({ kind: "dayOff", date: "2026-02-10", title: "Break", text: "Break\n2026-02-10 - 2026-02-14" });
    expect(detailOf("classFreeDays", context, { id: "d1", hash: "h", from: "", to: "", name: "" })).toMatchObject({ kind: "dayOff", date: null });
  });
});
