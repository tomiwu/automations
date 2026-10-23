import * as cheerio from "cheerio";
import { grosze, parseOrganizerAmount } from "./page-parse.ts";

/** The kinds of Organizer page that have a parser. `plain` is a simple page with a fee table. */
export type OrganizerType = "activenow" | "edusky" | "mondo" | "plain";

type Parser = (html: string, month: string) => number | undefined;

const MISSING = "Organizer page: fee list not found (site changed?)";

const activenow: Parser = (html, month) => {
  const $ = cheerio.load(html);
  if ($(".an-fees").length === 0) throw new Error(MISSING);
  const text = $(`.an-fees .an-fee[data-period="${month}"] .an-fee__price`).first().text();
  return text ? grosze(text) : undefined;
};

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
