import { describe, expect, it } from "vitest";
import {
  parseAbsences,
  parseAnnouncements,
  parseGrades,
  parseHomeworks,
  parseMessageBody,
  parseMessages,
  parseSubstitutions,
  parseTimetable,
  parseTrips,
} from "./parse.ts";

const gradesHtml = `<table><tr><td>1</td><td> Math </td><td><a class="ocena" href="/szczegoly/101">5</a>
<a class="ocena" href="/szczegoly/101">5</a><a class="ocena" href="/szczegoly/000000">9</a></td></tr>
<tr><td>2</td><td></td><td><a class="ocena" href="/szczegoly/102">4</a></td></tr></table>`;

describe("html parsers", () => {
  it("parses grades, skips template rows, duplicates and rows without subject", () => {
    expect(parseGrades(gradesHtml)).toEqual([{ id: "101", subject: "Math", grade: "5" }]);
  });

  it("parses the message list and skips rows without an ID", () => {
    const html = `<table><tr><td></td><td><input class="wiadomoscLista" value="m1"></td><td>Teacher One (Class 1a)</td><td> Hello </td><td>2026-01-05 10:00</td></tr>
<tr><td><input class="wiadomoscLista" value=""></td></tr></table>`;
    expect(parseMessages(html)).toEqual([{ id: "m1", sender: "Teacher One", subject: "Hello", sentAt: "2026-01-05 10:00" }]);
  });

  it("parses a message body with line breaks", () => {
    const html = `<div class="container-message-content"><p>Line  one<br>Line two</p><div>Last</div></div>`;
    expect(parseMessageBody(html)).toBe("Line one\nLine two\nLast");
  });

  it("parses announcements", () => {
    const html = `<div class="container-background"><table class="decorated"><thead><tr><td>Notice</td></tr></thead>
<tbody><tr><th>Czas publikacji</th><td>2026-01-05</td></tr><tr><th>Treść</th><td>${"x".repeat(150)}</td></tr></tbody></table>
<table class="decorated"><thead></thead></table></div>`;
    const [item, ...rest] = parseAnnouncements(html);
    expect(rest).toEqual([]);
    expect(item?.id).toBe("2026-01-05|Notice");
    expect(item?.summary).toHaveLength(141);
  });
});

describe("json parsers", () => {
  it("parses trips", () => {
    const json = JSON.stringify({ Data: [{ id: 7, destination: " Museum ", route: "A", locomotion: "Bus", termFrom: "2026-01-09 08:00", coordinatorName: "Teacher One" }] });
    expect(parseTrips(json)).toEqual([{ id: "7", destination: "Museum", route: "A", transport: "Bus", from: "2026-01-09", to: "2026-01-09", coordinator: "Teacher One" }]);
  });

  it("parses homework", () => {
    const json = JSON.stringify({ HomeWorks: [{ Id: 1, Content: "Read", Date: "2026-01-09", Category: { Id: 2 }, Subject: { Id: 3 }, CreatedBy: { Id: 4 } }, { Id: 2 }] });
    expect(parseHomeworks(json)).toEqual([
      { id: "1", content: "Read", date: "2026-01-09", categoryId: "2", subjectId: "3", teacherId: "4" },
      { id: "2", content: "", date: "", categoryId: "", subjectId: "", teacherId: "" },
    ]);
  });

  it("parses absences", () => {
    const json = JSON.stringify({ TeacherFreeDays: [{ Id: 1, DateFrom: "2026-01-09", TimeFrom: "08:00:00", Teacher: { Id: 4 }, AddDate: "2026-01-08 10:00:00" }] });
    expect(parseAbsences(json)).toEqual([{ id: "1", teacherId: "4", from: "2026-01-09", to: "2026-01-09", timeFrom: "08:00", timeTo: "", addedAt: "2026-01-08" }]);
  });

  it("parses substitutions", () => {
    const json = JSON.stringify({ Substitutions: [{ Id: 1, OrgDate: "2026-01-09", OrgLessonNo: 2, OrgSubject: { Id: 3 }, Teacher: { Id: 4 }, ClassroomSymbol: "5", IsCancelled: true }] });
    expect(parseSubstitutions(json)).toEqual([
      { id: "1", date: "2026-01-09", lessonNo: "2", orgSubjectId: "3", orgTeacherId: "", subjectId: "", teacherId: "4", classroom: "5", cancelled: true },
    ]);
  });

  it("rejects an answer without the expected array", () => {
    expect(() => parseTrips("{}")).toThrow("no Data array");
    expect(() => parseTimetable("{}")).toThrow("no Timetable object");
  });

  it("parses the timetable with statuses and teachers", () => {
    const json = JSON.stringify({
      Timetable: {
        "2026-01-09": [
          [{ LessonNo: "1", HourFrom: "08:00", HourTo: "08:45", Subject: { Name: "Math" }, Classroom: { Symbol: "5" }, Teacher: { FirstName: "Teacher", LastName: "One" } }],
          [],
          [{ LessonNo: "3", HourFrom: "10:00", HourTo: "10:45", Subject: { Name: "Art" }, IsCanceled: true, Teacher: { FirstName: "Teacher", LastName: "One" } }],
          [{ LessonNo: "4", HourFrom: "11:00", HourTo: "11:45", Subject: { Name: "Music" }, IsSubstitutionClass: true, Teacher: { FirstName: "Teacher", LastName: "Two" }, OrgTeacher: { FirstName: "Teacher", LastName: "One" } }],
        ],
      },
    });
    const lessons = parseTimetable(json);
    expect(lessons.map((l) => [l.period, l.status, l.teacher, l.substituteTeacher])).toEqual([
      [1, "normal", "Teacher One", ""],
      [3, "cancelled", "Teacher One", ""],
      [4, "substitution", "Teacher One", "Teacher Two"],
    ]);
    expect(lessons[0]).toMatchObject({ subject: "Math", room: "5", start: "08:00", end: "08:45" });
  });
});
