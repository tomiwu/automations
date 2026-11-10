import type { ModelSpec } from "./config.ts";

export const LIMIT_ERROR =
  /credit|quota|usage limit|rate limit|payment|out of (fast )?requests|insufficient|hit your .*limit|5-hour limit|resets/i;

export function isLimitError(text: string): boolean {
  return LIMIT_ERROR.test(text);
}

/** The wait when no reset time can be read from the limit errors. */
export const DEFAULT_LIMIT_WAIT_MS = 30 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const label = (spec: ModelSpec): string => `${spec.provider}:${spec.model}`;

function nextClockTime(now: Date, hour: number, minute: number): Date {
  const at = new Date(now);
  at.setHours(hour, minute, 0, 0);
  return at.getTime() <= now.getTime() ? new Date(at.getTime() + DAY_MS) : at;
}

function hour24(hour: number, meridiem: string | undefined): number {
  if (!meridiem) return hour;
  const pm = meridiem.toLowerCase() === "pm";
  return (hour % 12) + (pm ? 12 : 0);
}

/**
 * Reads the reset time of a limit error, for example "resets 4:30am", "resets at 16:05" or
 * "resets at 2026-11-10T03:30:00Z". A clock time is the next such time on the box clock. Returns undefined
 * when the text has no reset time.
 */
export function parseResetTime(text: string, now: Date): Date | undefined {
  return isoReset(text) ?? clockReset(text, now);
}

function isoReset(text: string): Date | undefined {
  const iso = /resets?\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(text);
  const at = new Date(iso?.[1] ?? "invalid");
  return Number.isNaN(at.getTime()) ? undefined : at;
}

function clockReset(text: string, now: Date): Date | undefined {
  const clock = /resets?\s+(?:at\s+)?(\d{1,2})(?!\d)(?::(\d{2}))?\s*(am|pm)?/i.exec(text);
  if (!clock) return undefined;
  const hour = hour24(Number(clock[1]), clock[3]);
  const minute = Number(clock[2] ?? 0);
  return hour < 24 && minute < 60 ? nextClockTime(now, hour, minute) : undefined;
}

/** Milliseconds until the earliest reset time of the errors, or the default wait. */
export function waitForReset(texts: readonly string[], now: Date, fallbackMs = DEFAULT_LIMIT_WAIT_MS): number {
  const waits = texts
    .map((text) => parseResetTime(text, now))
    .filter((at): at is Date => at !== undefined)
    .map((at) => at.getTime() - now.getTime())
    .filter((ms) => ms > 0);
  return waits.length ? Math.min(...waits) : fallbackMs;
}

// Tracks which model of the ordered list is active. A limit error moves to the next model.
export class ModelOrder {
  private index = 0;

  constructor(private readonly models: ModelSpec[]) {}

  current(): ModelSpec {
    return this.models[this.index] as ModelSpec;
  }

  // Returns the next model, or undefined when the list has no more models.
  advance(): ModelSpec | undefined {
    if (this.index + 1 >= this.models.length) return undefined;
    this.index += 1;
    return this.current();
  }

  // Goes back to the first model (after a wait for the limits to reset).
  reset(): void {
    this.index = 0;
  }
}

export interface FallbackOptions {
  log?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One short line of the reason of a limit error. */
const reasonOf = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 160);

// Run `attempt` with the active model. On a limit error, change to the next model and run the same phase again
// (`MODEL SWITCH <from> -> <to> (<reason>)`). When all models are limited, wait until the earliest reset time
// (or 30 minutes), go back to the first model and try again. The loop does not exit on limits.
function fallbackOptions(options: FallbackOptions | ((message: string) => void)): Required<FallbackOptions> {
  const given = typeof options === "function" ? { log: options } : options;
  return { log: () => {}, sleep: realSleep, now: () => new Date(), ...given };
}

/** All models are limited: wait until the earliest reset, then go back to the first model. */
async function waitAndReset(order: ModelOrder, limited: readonly string[], options: Required<FallbackOptions>): Promise<void> {
  const wait = waitForReset(limited, options.now());
  options.log(`ALL MODELS LIMITED. Wait ${Math.round(wait / 60000)} min, then start again with the first model.`);
  order.reset();
  await options.sleep(wait);
}

export async function withFallback<T>(
  order: ModelOrder,
  attempt: (model: ModelSpec) => Promise<T>,
  options: FallbackOptions | ((message: string) => void) = {},
): Promise<T> {
  const opts = fallbackOptions(options);
  let limited: string[] = [];
  for (;;) {
    try {
      return await attempt(order.current());
    } catch (error) {
      const text = `${error}`;
      if (!isLimitError(text)) throw error;
      limited.push(text);
      const failed = order.current();
      const next = order.advance();
      if (next) {
        opts.log(`MODEL SWITCH ${label(failed)} -> ${label(next)} (${reasonOf(text)})`);
        continue;
      }
      await waitAndReset(order, limited, opts);
      limited = [];
    }
  }
}
