import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { checked, isActiveNowBlock, openActiveNowPanel } from "@tomiwu/activities-watch";
import type { Http } from "@tomiwu/activities-watch";
import { grosze } from "./page-parse.ts";

type Row = ReturnType<cheerio.CheerioAPI>;

export type LedgerKind = "charge" | "payment";

export interface LedgerRow {
  date: string;
  title: string;
  /** Absolute amount in grosze. */
  amount: number;
  kind: LedgerKind;
}

export interface LedgerBanner {
  debt: boolean;
  /** Grosze from the debt heading, when present. */
  debtAmount?: number;
}

export interface ParsedLedger {
  rows: LedgerRow[];
  banner: LedgerBanner;
}

export type ChargeStatus = "covered" | "open" | "upcoming";

export interface MatchedCharge {
  date: string;
  title: string;
  amount: number;
  kind: "charge";
  status: ChargeStatus;
  key: string;
}

export interface MatchedLedger {
  rows: LedgerRow[];
  charges: MatchedCharge[];
  checked: boolean;
  /** Sum of open charge amounts with date on or before today. */
  openThroughToday: number;
}

const TABLE_MISSING = "ActiveNow settlements: table not found (site changed?)";
const HEADER_MISSING = "ActiveNow settlements: table header not found (site changed?)";
const ROW_MISMATCH = "ActiveNow settlements: desktop and mobile row counts differ (site changed?)";
const COLOUR_SIGN = "ActiveNow settlements: amount colour and sign disagree";

function must<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error(COLOUR_SIGN);
  return value;
}

const SETTLEMENTS_TABLE = "/client_panel/settlements/table?future_only=true";
const TABLE_TARGET = "[data-client-panel-page-settlements-target=table]";

const POLISH_MONTHS: Record<string, number> = {
  stycznia: 1,
  lutego: 2,
  marca: 3,
  kwietnia: 4,
  maja: 5,
  czerwca: 6,
  lipca: 7,
  sierpnia: 8,
  września: 9,
  października: 10,
  listopada: 11,
  grudnia: 12,
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Parses a Polish date, `DD.MM.YYYY`, or ISO `YYYY-MM-DD`. */
export function parseLedgerDate(text: string): string | undefined {
  const trimmed = text.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(trimmed);
  if (dotted) return `${dotted[3]}-${pad2(Number(dotted[2]))}-${pad2(Number(dotted[1]))}`;
  const polish = /^(\d{1,2})\s+([a-ząćęłńóśźż]+)\s+(\d{4})$/i.exec(trimmed);
  if (!polish) return undefined;
  const month = POLISH_MONTHS[polish[2]!.toLowerCase()];
  if (!month) return undefined;
  return `${polish[3]}-${pad2(month)}-${pad2(Number(polish[1]))}`;
}

function amountSign(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed.startsWith("-")) return -1;
  if (trimmed.startsWith("+")) return 1;
  const value = grosze(trimmed);
  if (value === undefined) return undefined;
  return value >= 0 ? 1 : -1;
}

/** Visible for tests: the colour token of a pill or mobile amount line. */
export function ledgerColourOf(classes: string, mobileTextClass: string): "red" | "green" | null {
  const parts = classes.split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (last === "red" || last === "green") return last;
  if (mobileTextClass.includes("text-red")) return "red";
  if (mobileTextClass.includes("text-green")) return "green";
  return null;
}

function kindOf(colour: "red" | "green", sign: number): LedgerKind {
  const charge = colour === "red" || sign < 0;
  const payment = colour === "green" || sign > 0;
  if (charge === payment) throw new Error(COLOUR_SIGN);
  return charge ? "charge" : "payment";
}

function isDesktopDataRow(classes: string): boolean {
  return classes.includes("hidden") && classes.includes("desktop:flex") && classes.includes("items-start") && !classes.includes("w-full");
}

function isMobileCard(classes: string): boolean {
  return classes.includes("desktop:hidden") && classes.includes("rounded-xl");
}

function hasHeader($: cheerio.CheerioAPI, root: Row): boolean {
  const header = root
    .find("div")
    .toArray()
    .find((node) => {
      const el = $(node);
      const cls = el.attr("class") ?? "";
      return cls.includes("desktop:flex") && cls.includes("w-full") && cls.includes("label");
    });
  if (!header) return false;
  const text = $(header).text();
  return text.includes("Data") && text.includes("Tytuł") && text.includes("Kwota");
}

function desktopRows($: cheerio.CheerioAPI, root: Row): Row[] {
  return root
    .find("div")
    .toArray()
    .filter((node) => isDesktopDataRow($(node).attr("class") ?? ""))
    .map((node) => $(node));
}

function mobileRows($: cheerio.CheerioAPI, root: Row): Row[] {
  return root
    .find("div")
    .toArray()
    .filter((node) => isMobileCard($(node).attr("class") ?? ""))
    .map((node) => $(node));
}

function ledgerRowFromParts(dateText: string, title: string, amountText: string, classes: string): LedgerRow {
  const sign = must(amountSign(amountText));
  const colour = must(ledgerColourOf(classes, ""));
  const amount = must(grosze(amountText));
  const date = must(parseLedgerDate(dateText));
  return { date, title, amount: Math.abs(amount), kind: kindOf(colour, sign) };
}

function rowFromDesktop($: cheerio.CheerioAPI, row: Row): LedgerRow {
  const parts = row.children("div");
  const pill = parts.eq(2);
  const amountText = pill.find("p").first().text() || pill.text();
  return ledgerRowFromParts(parts.eq(0).text().trim(), parts.eq(1).text().trim(), amountText, pill.attr("class") ?? "");
}

function parseBanner($: cheerio.CheerioAPI): LedgerBanner {
  const el = $('[data-controller*="settlements"] div.group').filter((_, node) => ($(node).attr("class") ?? "").includes("rounded-xl")).first();
  const debt = (el.attr("class") ?? "").includes("danger");
  const heading = el.find("h3.font-semibold").first().text().trim();
  const debtAmount = debt && heading ? grosze(heading) : undefined;
  return { debt, debtAmount: debtAmount === undefined ? undefined : Math.abs(debtAmount) };
}

function tableRoot($: cheerio.CheerioAPI): Row {
  const target = $(TABLE_TARGET);
  if (target.length > 0) return target.first();
  throw new Error(TABLE_MISSING);
}

/** Pure parser for one settlements page or table fragment. */
export function parseLedger(html: string): ParsedLedger {
  const $ = cheerio.load(html);
  const root = tableRoot($);
  if (root.length === 0) throw new Error(TABLE_MISSING);
  if (!hasHeader($, root)) throw new Error(HEADER_MISSING);
  const desktop = desktopRows($, root);
  const mobile = mobileRows($, root);
  if (desktop.length !== mobile.length) throw new Error(ROW_MISMATCH);
  return { rows: desktop.map((row) => rowFromDesktop($, row)), banner: parseBanner($) };
}

function rowKey(accountId: string, row: LedgerRow, titleHash: string, index: number): string {
  return `activenow:${accountId}:${row.date}:${row.kind}:${row.amount}:${titleHash}:${index}`;
}

export function titleHash(title: string): string {
  return createHash("sha256").update(title).digest("hex").slice(0, 12);
}

function sameRow(a: LedgerRow, b: LedgerRow): boolean {
  return a.date === b.date && a.title === b.title && a.amount === b.amount && a.kind === b.kind;
}

export function mergeLedgerRows(base: readonly LedgerRow[], extra: readonly LedgerRow[]): LedgerRow[] {
  const merged = [...base];
  for (const row of extra) {
    if (!merged.some((existing) => sameRow(existing, row))) merged.push(row);
  }
  return merged;
}

export function matchLedger(rows: readonly LedgerRow[], banner: LedgerBanner, today: string, accountId: string): MatchedLedger {
  const payments = rows.filter((row) => row.kind === "payment").reduce((sum, row) => sum + row.amount, 0);
  let pool = payments;
  const counts = new Map<string, number>();
  const charges = rows
    .filter((row) => row.kind === "charge")
    .sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  const matched: MatchedCharge[] = charges.map((row) => {
    const hash = titleHash(row.title);
    const base = `${row.date}:${row.kind}:${row.amount}:${hash}`;
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    const key = rowKey(accountId, row, hash, n);
    const upcoming = row.date > today;
    if (upcoming) return { date: row.date, title: row.title, amount: row.amount, kind: "charge", status: "upcoming", key };
    if (pool >= row.amount) {
      pool -= row.amount;
      return { date: row.date, title: row.title, amount: row.amount, kind: "charge", status: "covered", key };
    }
    return { date: row.date, title: row.title, amount: row.amount, kind: "charge", status: "open", key };
  });
  const openThroughToday = matched
    .filter((row) => row.date <= today && row.status !== "covered")
    .reduce((sum, row) => sum + row.amount, 0);
  let checked = true;
  if (!banner.debt) checked = openThroughToday === 0;
  else if (banner.debtAmount !== undefined) checked = openThroughToday === banner.debtAmount;
  return { rows: [...rows], charges: matched, checked, openThroughToday };
}

function settlementsHref(html: string, origin: string): string {
  const $ = cheerio.load(html);
  const link = $("a")
    .toArray()
    .find((node) => $(node).text().toLowerCase().includes("rozliczenia"));
  if (!link) throw new Error("ActiveNow settlements: Rozliczenia link not found (site changed?)");
  const href = $(link).attr("href");
  if (!href) throw new Error("ActiveNow settlements: Rozliczenia link not found (site changed?)");
  return new URL(href, origin).toString();
}

export interface ActiveNowLogin {
  login: string;
  password: string;
}

export interface ReadLedgerResult extends ParsedLedger {
  matched: MatchedLedger;
}

/** Reads and merges the settlements page and the upcoming table on one session. */
export async function readActiveNowLedger(
  http: Http,
  origin: string,
  accountId: string,
  secrets: ActiveNowLogin,
  profile: string | null,
  today: string,
): Promise<ReadLedgerResult> {
  const panel = await openActiveNowPanel(http, origin, secrets, profile);
  const billing = await checked(http, settlementsHref(panel, origin));
  const current = parseLedger(billing.text);
  const table = await checked(http, `${origin}${SETTLEMENTS_TABLE}`, {
    headers: { "x-requested-with": "XMLHttpRequest" },
  });
  const future = parseLedger(table.text);
  const rows = mergeLedgerRows(current.rows, future.rows);
  const banner = current.banner;
  const matched = matchLedger(rows, banner, today, accountId);
  return { rows, banner, matched };
}

export { isActiveNowBlock };