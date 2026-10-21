import { describe, expect, it } from "vitest";
import { compareWithMail, type MailFact } from "./mail-compare.ts";
import { CHILD1, session } from "./test-fixtures.ts";

const fact = (extra: Partial<MailFact> = {}): MailFact => ({
  childId: CHILD1,
  activity: "Choir",
  start: "2026-10-27T15:00",
  ...extra,
});

describe("compareWithMail", () => {
  it("finds no difference when the mail states nothing that differs", () => {
    const sessions = [session()];
    const result = compareWithMail(sessions, [fact(), fact({ status: "planned", place: " EXAMPLE hall " })]);
    expect(result.differences).toEqual([]);
    expect(result.sessions).toEqual(sessions);
  });

  it("warns about a Session that disagrees and keeps the app values", () => {
    const result = compareWithMail([session()], [fact({ status: "cancelled", end: "2026-10-27T16:30" })]);
    expect(result.sessions[0]?.warning).toBe("mail differs");
    expect(result.sessions[0]?.status).toBe("planned");
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]?.fields).toEqual(["status", "end"]);
    expect(result.differences[0]?.key).toBe(`mail-differs:${session().id}:status=cancelled|end=2026-10-27T16:30`);
  });

  it("renders the text in the language of the Recipient", () => {
    const [difference] = compareWithMail([session({ place: "" })], [fact({ status: "cancelled", place: "Room 9" })]).differences;
    expect(difference?.text("en")).toBe(
      "Mail differs from the app for Child One: Choir, 2026-10-27 15:00-16:00 (status: app planned, mail cancelled; place: app none, mail Room 9). The app is used.",
    );
    expect(difference?.text("pl")).toBe(
      "Mail różni się od aplikacji dla Child One: Choir, 2026-10-27 15:00-16:00 (status: aplikacja zaplanowane, mail odwołane; miejsce: aplikacja brak, mail Room 9). Obowiązuje aplikacja.",
    );
  });

  it("pairs a fact with a Session by Child, Activity and day", () => {
    const sessions = [session()];
    const result = compareWithMail(sessions, [
      fact({ childId: "other", status: "cancelled" }),
      fact({ activity: "Dance", status: "cancelled" }),
      fact({ start: "2026-10-28T15:00", status: "cancelled" }),
    ]);
    expect(result.differences).toEqual([]);
  });

  it("reports the first fact when many facts disagree with one Session", () => {
    const result = compareWithMail([session()], [fact({ status: "cancelled" }), fact({ status: "moved" })]);
    expect(result.differences).toHaveLength(1);
    expect(result.differences[0]?.fields).toEqual(["status"]);
    expect(result.differences[0]?.key).toContain("status=cancelled");
  });

  it("compares the start of a Session", () => {
    const result = compareWithMail([session()], [fact({ start: "2026-10-27T15:30" })]);
    expect(result.differences[0]?.fields).toEqual(["start"]);
  });
});
