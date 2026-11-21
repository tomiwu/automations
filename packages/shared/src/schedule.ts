import { addDays, localDate, localTime, weekdayOf } from "./time.ts";
import type { Activity } from "./config.ts";

/** Converts "HH:MM" to minutes after midnight. Throws on a bad value. */
export function parseTime(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!match) throw new Error(`Bad time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

export function runsOn(activity: Pick<Activity, "weekday" | "enabled">, weekday: number): boolean {
  return activity.enabled && activity.weekday === weekday;
}

/** Returns the Activities of one local date, sorted by start time. */
export function activitiesOn<T extends Pick<Activity, "weekday" | "enabled" | "start_time">>(
  activities: readonly T[],
  isoDate: string,
): T[] {
  const weekday = weekdayOf(isoDate);
  return activities
    .filter((activity) => runsOn(activity, weekday))
    .sort((a, b) => parseTime(a.start_time) - parseTime(b.start_time));
}

/** Returns the date of the next run of an Activity, from a date and a time of day. Today counts if the class has not started. */
export function nextOccurrence(
  activity: Pick<Activity, "weekday" | "start_time">,
  now: Date,
  timezone: string,
): string {
  const today = localDate(now, timezone);
  const ahead = (activity.weekday - weekdayOf(today) + 7) % 7;
  const started = parseTime(localTime(now, timezone)) >= parseTime(activity.start_time);
  return addDays(today, ahead === 0 && started ? 7 : ahead);
}
