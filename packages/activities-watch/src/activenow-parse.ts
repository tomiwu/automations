import * as cheerio from "cheerio";

type Card = ReturnType<ReturnType<cheerio.CheerioAPI["root"]>["find"]>;

export interface ActiveNowEvent {
  date: string;
  originalDate?: string;
  from: string;
  to: string;
  title: string;
  place: string;
  struckOut: boolean;
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

function monthAndDay(text: string): { month: number; day: number } | undefined {
  const match = /(\d{1,2})\s+(\p{L}+)/u.exec(text);
  const month = match ? MONTHS.indexOf((match[2] ?? "").toLowerCase()) : -1;
  return match && month >= 0 ? { month: month + 1, day: Number(match[1]) } : undefined;
}

const iso = (year: number, month: number, day: number): string =>
  `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

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

export function parseActiveNowEvents(html: string): ActiveNowEvent[] {
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
