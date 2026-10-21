import * as cheerio from "cheerio";

/** One element of the page, as the cheerio API gives it. */
type Card = ReturnType<ReturnType<cheerio.CheerioAPI["root"]>["find"]>;

/** A class card of the ActiveNow "all lessons" page, before the Activity is applied. */
export interface ActiveNowEvent {
  /** "YYYY-MM-DD" of the class now. */
  date: string;
  /** Day the class had before it moved: the struck-out date of the card. */
  originalDate?: string;
  /** "HH:MM". */
  from: string;
  to: string;
  /** Name of the group in the app. */
  title: string;
  place: string;
  /** The app strikes out the whole date of a class that is cancelled or that a Child will miss. */
  struckOut: boolean;
  /** Texts of the status chips. */
  badges: string[];
}

const MONTHS = [
  "stycznia",
  "lutego",
  "marca",
  "kwietnia",
  "maja",
  "czerwca",
  "lipca",
  "sierpnia",
  "września",
  "października",
  "listopada",
  "grudnia",
];

/** Reads "12 czerwca, piątek" as month and day numbers. Returns undefined when the text is not a date. */
function monthAndDay(text: string): { month: number; day: number } | undefined {
  const match = /(\d{1,2})\s+(\p{L}+)/u.exec(text);
  const month = match ? MONTHS.indexOf((match[2] ?? "").toLowerCase()) : -1;
  return match && month >= 0 ? { month: month + 1, day: Number(match[1]) } : undefined;
}

const iso = (year: number, month: number, day: number): string =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/** A struck-out date has no year. It is the nearest one to the section month, so December to January works. */
function originalYear(sectionYear: number, sectionMonth: number, month: number): number {
  if (month - sectionMonth > 6) return sectionYear - 1;
  return sectionMonth - month > 6 ? sectionYear + 1 : sectionYear;
}

function badgesOf($: cheerio.CheerioAPI, card: Card): string[] {
  return card
    .find(".rounded-full p")
    .map((_, p) => $(p).text().trim())
    .get();
}

function originalDateOf(dateBox: Card, year: number, sectionMonth: number): string | undefined {
  const before = monthAndDay(dateBox.find(".line-through").text());
  return before ? iso(originalYear(year, sectionMonth, before.month), before.month, before.day) : undefined;
}

function parseCard($: cheerio.CheerioAPI, card: Card, year: number, sectionMonth: number) {
  const header = card.find(".flex.flex-col.font-semibold").first();
  const dateBox = header.children().first();
  const now = monthAndDay(dateBox.clone().children().remove().end().text());
  const times = /(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/.exec(header.children().eq(1).text());
  if (!now || !times) return undefined;
  const event: ActiveNowEvent = {
    date: iso(year, now.month, now.day),
    originalDate: originalDateOf(dateBox, year, sectionMonth),
    from: times[1] ?? "",
    to: times[2] ?? "",
    struckOut: dateBox.hasClass("line-through"),
    title: card.find(".text-grey-500.text-xs.font-semibold").first().text().trim(),
    place: card.find(".location_on_20-icon").closest(".flex").find("span").last().text().trim(),
    badges: badgesOf($, card),
  };
  return event;
}

/**
 * Reads the cards of `/client_panel/all_events`. The page groups cards by month
 * (`data-navigation-date="YYYY-MM"`). A card shows no year, so the month gives it.
 * Cards that do not look like a class are skipped.
 */
export function parseActiveNowEvents(html: string): ActiveNowEvent[] {
  // The page keeps the body of each card in a <template>. Dropping the tags makes the place readable.
  const $ = cheerio.load(html.replace(/<\/?template\b[^>]*>/g, ""));
  const events: ActiveNowEvent[] = [];
  $("[data-navigation-date]").each((_, section) => {
    const [year = 0, month = 0] = ($(section).attr("data-navigation-date") ?? "").split("-").map(Number);
    $(section)
      .find("[data-controller=card]")
      .each((__, card) => {
        const event = parseCard($, $(card), year, month);
        if (event) events.push(event);
      });
  });
  return events;
}
