import * as cheerio from "cheerio";
import { grosze, parseOrganizerAmount } from "./page-parse.ts";

/** The kinds of Organizer page that have a parser. `plain` is a simple page with a fee table. */
export type OrganizerType = "activenow" | "edusky" | "mondo" | "plain";

type Parser = (html: string, month: string) => number | undefined;

const MISSING = "Organizer page: fee list not found (site changed?)";

/** Reads the amount of a month from the rows of a list. Throws when the list is not in the page. */
function fromRows(html: string, list: string, rowOf: (month: string) => string, cell: string, month: string) {
  const $ = cheerio.load(html);
  if ($(list).length === 0) throw new Error(MISSING);
  const text = $(list).find(rowOf(month)).first().find(cell).first().text();
  return text ? grosze(text) : undefined;
}

const activenow: Parser = (html, month) =>
  fromRows(html, ".an-fees", (m) => `.an-fee[data-period="${m}"]`, ".an-fee__price", month);

/** Edusky has the month in a cell, so the row is found by the text of that cell. */
const edusky: Parser = (html, month) => {
  const $ = cheerio.load(html);
  if ($("table.edusky-charges").length === 0) throw new Error(MISSING);
  const row = $("table.edusky-charges tr")
    .toArray()
    .find((candidate) => $(candidate).find(".period").first().text().trim() === month);
  return row ? grosze($(row).find(".sum").first().text()) : undefined;
};

/** Mondo shows the month as "MM.YYYY". */
const mondo: Parser = (html, month) => {
  const $ = cheerio.load(html);
  if ($(".mondo-fees").length === 0) throw new Error(MISSING);
  const [year, number] = month.split("-");
  const row = $(".mondo-fee")
    .toArray()
    .find((candidate) => $(candidate).find(".fee-date").first().text().trim() === `${number}.${year}`);
  return row ? grosze($(row).find(".fee-value").first().text()) : undefined;
};

const PARSERS: Record<OrganizerType, Parser> = { activenow, edusky, mondo, plain: parseOrganizerAmount };

/** Reads the amount in grosze of one month from an Organizer page of the given type. */
export function parseFeePage(type: OrganizerType, html: string, month: string): number | undefined {
  return PARSERS[type](html, month);
}

/** Finds the type of an Organizer page from the host name of its address. Other hosts are `plain`. */
export function organizerTypeOf(url: string): OrganizerType {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "plain";
  }
  return (["activenow", "edusky", "mondo"] as const).find((type) => host.includes(type)) ?? "plain";
}
