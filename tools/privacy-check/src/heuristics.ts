// Heuristics for personal data and tokens in one line of text. Documented example values are allowed.

export type Category =
  | "email"
  | "phone"
  | "iban"
  | "private-ip"
  | "telegram-chat-id"
  | "url-token"
  | "telegram-bot-token"
  | "jwt"
  | "supabase-ref"
  | "private-word";

interface Rule {
  category: Category;
  pattern: RegExp;
  /** True when the value (capture group 1, or the full match) is a documented example value. */
  allowed: (value: string) => boolean;
}

const EXAMPLE_EMAIL = /@(?:[\w-]+\.)*(?:example\.(?:com|org|net)|example|test|invalid|localhost|users\.noreply\.github\.com)$|^(?:noreply|no-reply)@|^git@github\.com$/i;
const EXAMPLE_CHAT_ID = /^-?1000\d{3}$/;
const PLACEHOLDER = /[<>${}%*]|example|placeholder|redacted|your|x{3}/i;
/** For a rule that has no documented example value. */
const never = () => false;

/** ISO 13616 mod-97 check. A number of 26 digits without a country code is a Polish account number. */
export function ibanValid(raw: string): boolean {
  const compact = raw.replace(/\s/g, "").toUpperCase();
  const iban = /^\d/.test(compact) ? `PL${compact}` : compact;
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  return BigInt(digits) % 97n === 1n;
}

const RULES: Rule[] = [
  {
    category: "email",
    pattern: /(?<![\w.+-])([a-z0-9][\w.+-]*@(?:[a-z0-9-]+\.)+[a-z]{2,})(?![\w-])/gi,
    allowed: (value) => EXAMPLE_EMAIL.test(value),
  },
  { category: "phone", pattern: /(?<![\w+])\+[1-9]\d{0,2}(?:[ -]?\d){9,10}(?!\d)/g, allowed: never },
  { category: "phone", pattern: /(?<![\d-]|\d )\d{3}[ -]\d{3}[ -]\d{3}(?![\d-]| \d)/g, allowed: never },
  {
    category: "iban",
    pattern: /(?<![A-Za-z0-9])(?:[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?|\d{2}(?: ?\d{4}){6})(?![A-Za-z0-9])/g,
    allowed: (value) => !ibanValid(value),
  },
  {
    category: "private-ip",
    pattern: /(?<![\d.])(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])|169\.254)\.\d{1,3}\.\d{1,3}(?![\d.])/g,
    allowed: never,
  },
  {
    category: "telegram-chat-id",
    pattern: /(?:chat|sender|telegram)[_ -]?ids?["']?\s{0,2}[:=,]?\s{0,2}["'[(]{0,2}(-?\d{6,})(?!\d)/gi,
    allowed: (value) => EXAMPLE_CHAT_ID.test(value),
  },
  { category: "telegram-chat-id", pattern: /(?<![\w-])-100\d{10}(?!\d)/g, allowed: never },
  {
    category: "url-token",
    pattern: /https?:\/\/[^\s"'<>`]*[?&](?:access_token|api_key|apikey|auth|key|password|secret|sig|signature|token)=([^&\s"'<>#`]{8,})/gi,
    allowed: (value) => PLACEHOLDER.test(value),
  },
  { category: "telegram-bot-token", pattern: /(?<![\w:])\d{8,10}:[A-Za-z0-9_-]{35}(?![\w-])/g, allowed: never },
  { category: "jwt", pattern: /(?<![\w-])eyJ[\w-]{10,}\.eyJ[\w-]{10,}\.[\w-]{10,}/g, allowed: never },
  { category: "supabase-ref", pattern: /(?<![a-z0-9])[a-z0-9]{20}\.supabase\.(?:co|com|in)\b/g, allowed: never },
];

function isFinding(rule: Rule, match: RegExpMatchArray, allowValues: Set<string>): boolean {
  const value = match[1] ?? match[0];
  return !allowValues.has(value) && !allowValues.has(match[0]) && !rule.allowed(value);
}

function ruleHits(rule: Rule, line: string, allowValues: Set<string>): boolean {
  return [...line.matchAll(rule.pattern)].some((match) => isFinding(rule, match, allowValues));
}

/** The categories with a finding in the line, each one time, in the order of the rules. */
export function scanLine(line: string, allowValues: Set<string>): Category[] {
  const found = RULES.filter((rule) => ruleHits(rule, line, allowValues)).map((rule) => rule.category);
  return [...new Set(found)];
}
