import type { FetchFn } from "@automations/shared";
import { hoursOpen, parseHours } from "./hours.ts";
import { readActive, rejectUnknown, textField } from "./input.ts";

export const WEBHOOK_URL = /^https:\/\/api2\.cursor\.sh\/automations\/webhook\/[A-Za-z0-9_-]{1,128}$/;
const SLUG = /^[a-z][a-z0-9-]{0,40}$/;
const RESERVED_SLUG = "create_new_bot";

export interface BotRecord {
  slug: string;
  name: string;
  description: string;
  activeHours: string;
  webhookUrl: string;
  webhookKeyCiphertext: string;
  active: boolean;
}

export interface BotDraft {
  slug: string;
  name: string;
  description: string;
  activeHours: string;
  webhookUrl: string;
  /** Empty when an edit keeps the stored key. */
  webhookKey: string;
  active: boolean;
}

export interface BotRegistry {
  list(familyId: string): Promise<BotRecord[]>;
  upsert(familyId: string, bot: BotRecord): Promise<void>;
  timezone(familyId: string): Promise<string>;
}

export interface SupabaseRest {
  url: string;
  key: string;
  fetch: FetchFn;
}

const BOT_KEYS = ["slug", "name", "description", "activeHours", "webhookUrl", "webhookKey", "active"];

/** True when the bot can take a message now. The hub ignores active hours. */
export function isRoutable(bot: BotRecord, now: Date, timeZone: string): boolean {
  if (!bot.active) return false;
  if (bot.slug === "hub") return true;
  return hoursOpen(bot.activeHours, now, timeZone);
}

/** Checks a webhook URL. Only Cursor routine webhooks are allowed. */
export function assertWebhookUrl(url: string): string {
  if (!WEBHOOK_URL.test(url)) {
    throw new Error("webhookUrl must be https://api2.cursor.sh/automations/webhook/<id> with no query.");
  }
  return url;
}

/** Validates a registry write. `keyRequired` is false when an edit keeps the current key. */
export function parseBotDraft(raw: unknown, keyRequired: boolean): BotDraft {
  const record = rejectUnknown(raw, BOT_KEYS);
  const webhookKey = textField(record, "webhookKey") ?? "";
  requireKey(keyRequired, webhookKey);
  const activeHours = textField(record, "activeHours") ?? "always";
  parseHours(activeHours);
  return {
    slug: requireSlug(textField(record, "slug")),
    name: bounded(textField(record, "name"), "name", 80),
    description: bounded(textField(record, "description"), "description", 500),
    activeHours,
    webhookUrl: assertWebhookUrl(urlText(textField(record, "webhookUrl"))),
    webhookKey,
    active: readActive(record.active, true),
  };
}

function urlText(value: string | null): string {
  return value ?? "";
}

function requireKey(keyRequired: boolean, webhookKey: string): void {
  if (keyRequired && webhookKey === "") throw new Error("webhookKey is required.");
  if (webhookKey !== "" && !validKey(webhookKey)) throw new Error("webhookKey must be 8 to 200 characters on one line.");
}

function requireSlug(value: string | null): string {
  if (!value || !SLUG.test(value) || value === RESERVED_SLUG) throw new Error("slug must be a short lowercase id, not create_new_bot.");
  return value;
}

function bounded(value: string | null, label: string, max: number): string {
  const text = value?.trim() ?? "";
  if (text === "" || text.length > max) throw new Error(`${label} must be 1 to ${max} characters.`);
  return text;
}

function validKey(value: string): boolean {
  return value.length >= 8 && value.length <= 200 && !/[\r\n]/.test(value);
}

/** PostgREST access to `kradziejka_bots`. The watcher role can select, insert and update. */
export function createSupabaseRegistry(options: SupabaseRest): BotRegistry {
  const base = `${options.url.replace(/\/+$/, "")}/rest/v1`;
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    apikey: options.key,
    authorization: `Bearer ${options.key}`,
    ...extra,
  });

  async function request(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    const response = await options.fetch(`${base}/${path}`, { ...init, method });
    if (!response.ok) throw new Error(`Supabase ${method} ${path.split("?")[0]} failed: ${response.status}`);
    return response;
  }

  return {
    async list(familyId) {
      const query = `family_id=eq.${encodeURIComponent(familyId)}&select=slug,name,description,active_hours,webhook_url,webhook_key_ciphertext,active&order=slug.asc`;
      const response = await request("GET", `kradziejka_bots?${query}`, { headers: headers() });
      const rows = (await response.json()) as Record<string, unknown>[];
      return rows.map(toBot);
    },
    async upsert(familyId, bot) {
      const init = {
        headers: headers({ "content-type": "application/json", prefer: "resolution=merge-duplicates,return=minimal" }),
        body: JSON.stringify([toRow(familyId, bot)]),
      };
      await request("POST", "kradziejka_bots?on_conflict=family_id,slug", init);
    },
    async timezone(familyId) {
      const response = await request("GET", `families?id=eq.${encodeURIComponent(familyId)}&select=timezone`, { headers: headers() });
      const rows = (await response.json()) as { timezone?: unknown }[];
      return typeof rows[0]?.timezone === "string" && rows[0].timezone !== "" ? rows[0].timezone : "UTC";
    },
  };
}

function toBot(row: Record<string, unknown>): BotRecord {
  return {
    slug: String(row.slug),
    name: String(row.name),
    description: String(row.description),
    activeHours: String(row.active_hours),
    webhookUrl: String(row.webhook_url),
    webhookKeyCiphertext: String(row.webhook_key_ciphertext),
    active: row.active === true,
  };
}

function toRow(familyId: string, bot: BotRecord): Record<string, unknown> {
  return {
    family_id: familyId,
    slug: bot.slug,
    name: bot.name,
    description: bot.description,
    active_hours: bot.activeHours,
    webhook_url: bot.webhookUrl,
    webhook_key_ciphertext: bot.webhookKeyCiphertext,
    active: bot.active,
    updated_at: new Date().toISOString(),
  };
}
