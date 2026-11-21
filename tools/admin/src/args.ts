export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string>;
}

export function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { positional: [], flags: {} };
  let i = 0;
  while (i < args.length) i += takeArg(args, i, parsed);
  return parsed;
}

function takeArg(args: readonly string[], index: number, parsed: ParsedArgs): number {
  const arg = String(args[index]);
  if (!arg.startsWith("--")) {
    parsed.positional.push(arg);
    return 1;
  }
  const next = String(args[index + 1]);
  const hasValue = index + 1 < args.length && !next.startsWith("--");
  parsed.flags[arg.slice(2)] = hasValue ? next : "true";
  return hasValue ? 2 : 1;
}

export function required(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (value === undefined || value === "true") throw new Error(`Missing option --${name}`);
  return value;
}

export function oneOf(value: string, allowed: readonly string[], name: string): string {
  if (!allowed.includes(value)) throw new Error(`Option --${name} must be one of: ${allowed.join(", ")}`);
  return value;
}

const SECRET_NAME = /^[A-Z][A-Z0-9_]*$/;

export function secretName(value: string, name: string): string {
  if (!SECRET_NAME.test(value)) throw new Error(`Option --${name} takes a secret NAME, for example CHILD1_LIBRUS_LOGIN. Never enter a value.`);
  return value;
}

export function weekday(value: string): number {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > 7) throw new Error("Option --weekday must be 1 (Monday) to 7 (Sunday)");
  return day;
}
