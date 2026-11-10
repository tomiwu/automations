export const MASK = "[REDACTED]";

const MIN_SECRET_LENGTH = 4;
const SECRET_NAME = /(?:_TOKEN|_KEY|_SECRET)$/;

// Token shapes and NAME_TOKEN= / NAME_KEY= assignments. The assignment keeps its name.
const TOKEN_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]+/g,
  /gh[pos]_[A-Za-z0-9]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
];
const ASSIGNMENT = /\b([A-Za-z][A-Za-z0-9_]*_(?:TOKEN|KEY))=("[^"]*"|'[^']*'|\S+)/g;

function unquote(value: string): string {
  const quoted = /^(["'])(.*)\1$/.exec(value);
  return quoted?.[2] ?? value;
}

// Read the values of a dotenv file. Comments and empty lines are ignored.
export function parseEnvValues(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"))
    .map((line) => unquote(line.slice(line.indexOf("=") + 1).trim()));
}

// Values of the environment variables whose name ends with _TOKEN, _KEY or _SECRET.
export function secretValuesFromEnv(env: Record<string, string | undefined>): string[] {
  return Object.entries(env).filter(([name]) => SECRET_NAME.test(name)).map(([, value]) => value ?? "");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Build a function that masks every known secret value and every token pattern.
export function buildRedactor(secretValues: string[]): (line: string) => string {
  const values = [...new Set(secretValues)].filter((v) => v.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  const exact = values.length ? new RegExp(values.map(escapeRegExp).join("|"), "g") : undefined;
  return (line) => {
    let out = exact ? line.replace(exact, MASK) : line;
    out = out.replace(ASSIGNMENT, `$1=${MASK}`);
    return TOKEN_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, MASK), out);
  };
}
