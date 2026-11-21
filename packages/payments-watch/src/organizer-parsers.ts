import * as cheerio from "cheerio";
import { grosze } from "./page-parse.ts";

/** The kinds of Organizer page that have a parser. `plain` is a simple page with a fee table. */
export type OrganizerType = "activenow" | "edusky" | "mondo" | "plain";

type Row = ReturnType<cheerio.CheerioAPI>;

/** Where a parser finds the list, the charges, the month and the amount of an Organizer page. */
interface PageSpec {
  list: string;
  rows: string;
  /** The month `YYYY-MM` of a charge row, or an empty text when the row is not a charge. */
  month(row: Row): string;
  amount: string;
}

const MISSING = "Organizer page: fee list not found (site changed?)";

const activenow: PageSpec = {
  list: ".an-fees",
  rows: ".an-fee",
  month: (row) => row.attr("data-period") ?? "",
  amount: ".an-fee__price",
};

/** Edusky has the month in a cell, so the row is found by the text of that cell. */
const edusky: PageSpec = {
  list: "table.edusky-charges",
  rows: "table.edusky-charges tr",
  month: (row) => row.find(".period").first().text().trim(),
  amount: ".sum",
};

/** Mondo shows the month as "MM.YYYY". */
const mondo: PageSpec = {
  list: ".mondo-fees",
  rows: ".mondo-fee",
  month: (row) => {
    const [number = "", year = ""] = row.find(".fee-date").first().text().trim().split(".");
    return year && number ? `${year}-${number}` : "";
  },
  amount: ".fee-value",
};

const plain: PageSpec = {
  list: "table.fees",
  rows: "table.fees tr",
  month: (row) => row.attr("data-month") ?? "",
  amount: ".amount",
};

const SPECS: Record<OrganizerType, PageSpec> = { activenow, edusky, mondo, plain };

/**
 * What a page shows about one charge. `listed`: the charge is there. `cancelled`: the charge is marked cancelled.
 * `absent`: the page has other charges but not this one. `withdrawn`: the page shows that the Child is not enrolled.
 * `empty`: the parser found no charge at all, so the page tells nothing.
 */
export type ChargeState = "listed" | "cancelled" | "absent" | "withdrawn" | "empty";

export interface FeePageReading {
  state: ChargeState;
  /** The amount in grosze of a `listed` charge. */
  amount?: number;
}

const CANCEL_MARK = '[data-status="cancelled"], [class*="cancel"]';
const WITHDRAWN_MARK = '[data-enrolled="false"], [class*="withdrawn"]';

const isCancelled = (row: Row): boolean => row.is(CANCEL_MARK) || row.find(CANCEL_MARK).length > 0;

function listed(spec: PageSpec, row: Row): FeePageReading {
  const amount = grosze(row.find(spec.amount).first().text());
  return amount === undefined ? { state: "listed" } : { state: "listed", amount };
}

function stateOf(spec: PageSpec, $: cheerio.CheerioAPI, charges: readonly Row[], month: string): FeePageReading {
  if (charges.length === 0) return { state: "empty" };
  if ($(WITHDRAWN_MARK).length > 0) return { state: "withdrawn" };
  const row = charges.find((candidate) => spec.month(candidate) === month);
  if (!row) return { state: "absent" };
  return isCancelled(row) ? { state: "cancelled" } : listed(spec, row);
}

/**
 * Reads what an Organizer page of the given type shows about the charge of one month.
 * Throws when the page has no fee list, because the page probably changed.
 */
export function readFeePage(type: OrganizerType, html: string, month: string): FeePageReading {
  const spec = SPECS[type];
  const $ = cheerio.load(html);
  if ($(spec.list).length === 0) throw new Error(MISSING);
  const charges = $(spec.rows)
    .toArray()
    .map((node) => $(node))
    .filter((row) => spec.month(row) !== "");
  return stateOf(spec, $, charges, month);
}

/** Reads the amount in grosze of one month from an Organizer page of the given type. */
export function parseFeePage(type: OrganizerType, html: string, month: string): number | undefined {
  return readFeePage(type, html, month).amount;
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
