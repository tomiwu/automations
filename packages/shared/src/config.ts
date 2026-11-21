export const SERVICES = ["librus", "activenow", "edusky", "mondo"] as const;
export type Service = (typeof SERVICES)[number];

export const LANGUAGES = ["pl", "en"] as const;
export type Language = (typeof LANGUAGES)[number];

export interface Family {
  id: string;
  name: string;
  timezone: string;
  default_language: Language;
}

export interface Child {
  id: string;
  family_id: string;
  name: string;
  has_librus: boolean;
  calendar_id: string | null;
}

/** The login of a Child at a Service. It holds secret NAMES, never secret values. */
export interface Account {
  id: string;
  family_id: string;
  child_id: string;
  service: Service;
  origin: string;
  group: string | null;
  login_secret: string;
  password_secret: string;
  enabled: boolean;
}

/** A recurring class after school. `weekday` is 1 (Monday) to 7 (Sunday). Times are "HH:MM". */
export interface Activity {
  id: string;
  family_id: string;
  child_id: string;
  account_id: string;
  name: string;
  weekday: number;
  start_time: string;
  end_time: string;
  place: string | null;
  enabled: boolean;
}

export interface Recipient {
  id: string;
  family_id: string;
  telegram_chat_id: string;
  language: Language;
  child_ids: string[];
}

export interface Config {
  family: Family;
  children: Child[];
  accounts: Account[];
  activities: Activity[];
  recipients: Recipient[];
}

export type Raw<T> = { [K in keyof T]?: unknown };

export interface RawConfig {
  family: Raw<Family>;
  children: Raw<Child>[];
  accounts: Raw<Account>[];
  activities: Raw<Activity>[];
  recipients: Raw<Recipient>[];
}

export type ConfigErrorCode =
  | "unknown_service"
  | "missing_secret_name"
  | "bad_language"
  | "bad_origin"
  | "unknown_child";

export interface ConfigError {
  subject: "account" | "recipient";
  id: string;
  code: ConfigErrorCode;
  message: string;
}

export interface ConfigValidation {
  /** The Accounts without an error. Only these Accounts run. */
  accounts: Account[];
  recipients: Recipient[];
  errors: ConfigError[];
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isLanguage(value: unknown): value is Language {
  return (LANGUAGES as readonly unknown[]).includes(value);
}

function isService(value: unknown): value is Service {
  return (SERVICES as readonly unknown[]).includes(value);
}

function isHttpOrigin(value: unknown): boolean {
  if (!isText(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function accountError(account: Raw<Account>, code: ConfigErrorCode, message: string): ConfigError {
  const id = String(account.id ?? "");
  return { subject: "account", id, code, message: `Account ${id}: ${message}` };
}

function secretError(account: Raw<Account>): ConfigError | undefined {
  for (const field of ["login_secret", "password_secret"] as const) {
    if (!isText(account[field])) return accountError(account, "missing_secret_name", `${field} is missing`);
  }
  return undefined;
}

function linkError(account: Raw<Account>, childIds: ReadonlySet<string>): ConfigError | undefined {
  if (!isHttpOrigin(account.origin)) {
    return accountError(account, "bad_origin", "origin is not an http or https URL");
  }
  if (typeof account.child_id !== "string" || !childIds.has(account.child_id)) {
    return accountError(account, "unknown_child", `child "${String(account.child_id)}" is not in the Family`);
  }
  return undefined;
}

export function validateAccount(account: Raw<Account>, childIds: ReadonlySet<string>): ConfigError | undefined {
  if (!isService(account.service)) {
    return accountError(account, "unknown_service", `unknown service "${String(account.service)}"`);
  }
  const missing = secretError(account);
  if (missing) return missing;
  return linkError(account, childIds);
}

export function validateRecipient(recipient: Raw<Recipient>): ConfigError | undefined {
  if (isLanguage(recipient.language)) return undefined;
  const id = String(recipient.id ?? "");
  return {
    subject: "recipient",
    id,
    code: "bad_language",
    message: `Recipient ${id}: language "${String(recipient.language)}" is not one of ${LANGUAGES.join(", ")}`,
  };
}

/**
 * Checks each enabled Account and each Recipient on its own.
 * A bad row gives one error. The other rows stay valid.
 */
export function validateConfig(raw: RawConfig): ConfigValidation {
  const childIds = new Set(raw.children.map((child) => String(child.id)));
  const errors: ConfigError[] = [];
  const accounts: Account[] = [];
  const recipients: Recipient[] = [];
  for (const account of raw.accounts.filter((row) => row.enabled !== false)) {
    const error = validateAccount(account, childIds);
    if (error) errors.push(error);
    else accounts.push(account as unknown as Account);
  }
  for (const recipient of raw.recipients) {
    const error = validateRecipient(recipient);
    if (error) errors.push(error);
    else recipients.push(recipient as unknown as Recipient);
  }
  return { accounts, recipients, errors };
}
