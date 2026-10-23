import * as cheerio from "cheerio";

const AMOUNT = /(\d[\d\s ]*)(?:[,.](\d{1,2}))?/;

/** Reads "1 250,50 zł" as 125050 grosze. Returns undefined when the text has no number. */
export function grosze(text: string): number | undefined {
  const match = AMOUNT.exec(text);
  if (!match) return undefined;
  const whole = Number((match[1] ?? "").replace(/\D/g, ""));
  return whole * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

/**
 * Reads the amount of one month from the fee table of the Organizer page. Each month is one row
 * `tr[data-month="YYYY-MM"]` with a cell `.amount`. Returns undefined when the page has no amount for the month.
 * Throws when the page has no fee table, because the page probably changed.
 */
export function parseOrganizerAmount(html: string, month: string): number | undefined {
  const $ = cheerio.load(html);
  if ($("table.fees").length === 0) throw new Error("Organizer page: fee list not found (site changed?)");
  const row = $("table.fees tr")
    .toArray()
    .find((candidate) => $(candidate).attr("data-month") === month);
  return row ? grosze($(row).find(".amount").first().text()) : undefined;
}
