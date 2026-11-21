import * as cheerio from "cheerio";

type Row = ReturnType<ReturnType<cheerio.CheerioAPI["root"]>["find"]>;

export interface MondoEvent {
  start: string;
  end: string;
  place: string;
  status: "planned" | "cancelled" | "moved";
}

const CANCELLED = /odwołan|anulowan/i;
const MOVED = /przeniesion|zmian\p{L}* termin/iu;
const TIMES = /(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})/;
const DATE = /(\d{1,2})\s+(\p{L}{3})\p{L}*\s+(\d{4})/u;
const MONTHS = ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"];

const pad = (value: string | undefined): string => (value ?? "").padStart(2, "0");

export function isoDate(text: string): string | undefined {
  const match = DATE.exec(text);
  const month = MONTHS.indexOf((match?.[2] ?? "").toLowerCase());
  return match && month >= 0 ? `${match[3]}-${pad(String(month + 1))}-${pad(match[1])}` : undefined;
}

function statusOf(text: string): MondoEvent["status"] {
  if (CANCELLED.test(text)) return "cancelled";
  return MOVED.test(text) ? "moved" : "planned";
}

function toEvent(row: Row): MondoEvent | undefined {
  const right = row.find(".flex-column").first();
  const date = isoDate(right.find(".fw-bold").first().text());
  const times = TIMES.exec(right.find(".text-secondary").first().text());
  if (!date || !times) return undefined;
  const at = (hour: string | undefined, minute: string | undefined): string => `${date}T${pad(hour)}:${minute}`;
  return {
    start: at(times[1], times[2]),
    end: at(times[3], times[4]),
    place: row.find(".col .text-secondary").first().text().trim(),
    status: statusOf(row.find(".rounded-pill").text()),
  };
}

const classId = (onclick: string | undefined): string => /showDetails\('[^']*',\s*'([^']+)'/.exec(onclick ?? "")?.[1] ?? "";

export function parseMondoEvents(html: string): MondoEvent[] {
  const $ = cheerio.load(html);
  if ($("#pills-tabContent").length === 0) throw new Error("Mondo: class list not found (site changed?)");
  const byId = new Map<string, MondoEvent | undefined>();
  $('button[onclick^="showDetails"]').each((_, button) => {
    const id = classId($(button).attr("onclick"));
    if (!byId.has(id)) byId.set(id, toEvent($(button)));
  });
  return [...byId.values()]
    .filter((event): event is MondoEvent => event !== undefined)
    .sort((a, b) => a.start.localeCompare(b.start));
}
