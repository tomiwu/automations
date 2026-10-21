import { describe, expect, it } from "vitest";
import { parseActiveNowEvents } from "./activenow-parse.ts";
import { card, month } from "./test-fixtures.ts";

describe("parseActiveNowEvents", () => {
  it("reads the day, the times, the group and the place of a card; the month section gives the year", () => {
    const [event] = parseActiveNowEvents(month("2026-10", card({ date: "27 października, wtorek" })));
    expect(event).toEqual({
      date: "2026-10-27",
      originalDate: undefined,
      from: "15:00",
      to: "16:00",
      struckOut: false,
      title: "Group Blue",
      place: "Example Hall",
      badges: [],
    });
  });

  it("reads the struck-out day of a moved card and its chips", () => {
    const html = month(
      "2026-06",
      card({ date: "12 czerwca, piątek", original: "11 czerwca, czwartek", badges: ["Zmieniony termin", "Zastępstwo"] }),
    );
    const [event] = parseActiveNowEvents(html);
    expect(event?.date).toBe("2026-06-12");
    expect(event?.originalDate).toBe("2026-06-11");
    expect(event?.badges).toEqual(["Zmieniony termin", "Zastępstwo"]);
  });

  it("takes the year of the old day from the nearest month over New Year", () => {
    const forward = card({ date: "2 stycznia, sobota", original: "29 grudnia, wtorek" });
    expect(parseActiveNowEvents(month("2027-01", forward))[0]?.originalDate).toBe("2026-12-29");
    const back = card({ date: "29 grudnia, wtorek", original: "2 stycznia, sobota" });
    expect(parseActiveNowEvents(month("2026-12", back))[0]?.originalDate).toBe("2027-01-02");
  });

  it("reports a struck-out date", () => {
    const html = month("2026-10", card({ date: "6 października, wtorek", struck: true, badges: ["Zgłoszona nieobecność"] }));
    const [event] = parseActiveNowEvents(html);
    expect(event?.struckOut).toBe(true);
    expect(event?.date).toBe("2026-10-06");
  });

  it("keeps the page order and skips a card without a readable date", () => {
    const html =
      month("2026-10", card({ date: "20 października, wtorek" }), card({ date: "brak daty" })) +
      month("2026-11", card({ date: "3 listopada, wtorek" }));
    expect(parseActiveNowEvents(html).map((e) => e.date)).toEqual(["2026-10-20", "2026-11-03"]);
  });

  it("gives no events for a page without cards", () => {
    expect(parseActiveNowEvents("<html><body>Brak lekcji</body></html>")).toEqual([]);
  });
});
