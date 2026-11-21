const DAY_MS = 86_400_000;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 1 (Monday) to 7 (Sunday). */
  weekday: number;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function zonedParts(date: Date, timezone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
  });
  const map: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) map[part.type] = part.value;
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    weekday: WEEKDAYS.indexOf(map.weekday ?? "") + 1,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** Returns the local date as "YYYY-MM-DD" in the time zone. */
export function localDate(date: Date, timezone: string): string {
  const { year, month, day } = zonedParts(date, timezone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Returns the local time as "HH:MM" in the time zone. */
export function localTime(date: Date, timezone: string): string {
  const { hour, minute } = zonedParts(date, timezone);
  return `${pad(hour)}:${pad(minute)}`;
}

/** Adds days to a "YYYY-MM-DD" date. The result is "YYYY-MM-DD". */
export function addDays(isoDate: string, days: number): string {
  const time = Date.parse(`${isoDate}T00:00:00Z`);
  if (Number.isNaN(time)) throw new Error(`Bad date: ${isoDate}`);
  return new Date(time + days * DAY_MS).toISOString().slice(0, 10);
}

/** Returns the weekday of a "YYYY-MM-DD" date: 1 (Monday) to 7 (Sunday). */
export function weekdayOf(isoDate: string): number {
  const day = new Date(`${isoDate}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}
