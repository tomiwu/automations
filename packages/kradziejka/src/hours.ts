import { zonedParts } from "@automations/shared";

export interface ClockParts {
  weekday: number;
  minute: number;
}

export type HoursSpec =
  | { kind: "always" }
  | { kind: "window"; fromDay: number; toDay: number; start: number; end: number };

const TIME = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

/** Parses `always`, `HH:MM-HH:MM`, or `D-D HH:MM-HH:MM` (1 = Monday, 7 = Sunday). */
export function parseHours(value: string): HoursSpec {
  const text = value.trim();
  if (text === "always") return { kind: "always" };
  const days = text.match(/^([1-7])-([1-7]) ([0-9]{2}:[0-9]{2})-([0-9]{2}:[0-9]{2})$/);
  if (days) return windowSpec(group(days, 1), group(days, 2), group(days, 3), group(days, 4));
  return dailyWindow(text);
}

function group(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) return "";
  return value;
}

function dailyWindow(text: string): HoursSpec {
  const daily = text.match(/^([0-9]{2}:[0-9]{2})-([0-9]{2}:[0-9]{2})$/);
  if (!daily) throw new Error("activeHours must be always, HH:MM-HH:MM, or D-D HH:MM-HH:MM.");
  return windowSpec("1", "7", group(daily, 1), group(daily, 2));
}

function windowSpec(fromDay: string, toDay: string, start: string, end: string): HoursSpec {
  const from = Number(fromDay);
  const to = Number(toDay);
  if (from > to) throw new Error("The weekday range must start on or before the end day.");
  return { kind: "window", fromDay: from, toDay: to, start: minutes(start), end: minutes(end) };
}

function minutes(value: string): number {
  const match = value.match(TIME);
  if (!match) throw new Error("A time must be HH:MM in 24-hour form.");
  return Number(match[1]) * 60 + Number(match[2]);
}

/** True when `now` is inside the window in the given IANA time zone. */
export function isOpen(spec: HoursSpec, now: Date, timeZone: string): boolean {
  if (spec.kind === "always") return true;
  const parts = clockParts(now, timeZone);
  if (!dayMatches(spec, parts.weekday)) return false;
  return minuteMatches(spec, parts.minute);
}

export function clockParts(now: Date, timeZone: string): ClockParts {
  const parts = zonedParts(now, timeZone);
  const hour = parts.hour === 24 ? 0 : parts.hour;
  return { weekday: parts.weekday, minute: hour * 60 + parts.minute };
}

function dayMatches(spec: Extract<HoursSpec, { kind: "window" }>, weekday: number): boolean {
  return weekday >= spec.fromDay && weekday <= spec.toDay;
}

function minuteMatches(spec: Extract<HoursSpec, { kind: "window" }>, minute: number): boolean {
  if (spec.start === spec.end) return false;
  if (spec.start < spec.end) return minute >= spec.start && minute < spec.end;
  return minute >= spec.start || minute < spec.end;
}

/** True when the hours text is open. A bad text is closed. */
export function hoursOpen(activeHours: string, now: Date, timeZone: string): boolean {
  try {
    return isOpen(parseHours(activeHours), now, timeZone);
  } catch {
    return false;
  }
}
