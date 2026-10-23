import type { Config, FetchFn, Runtime } from "@automations/shared";
import type { Fee, NewNotification, NewPayment, OutboxEntry, Payment, StorageAdapter, StoredItem } from "./storage.ts";

const DAY_MS = 86_400_000;
const JSON_HEADERS = { "content-type": "application/json" };
const INSERT_NEW = "resolution=ignore-duplicates,return=representation";

type Row = Record<string, unknown>;

export interface SupabaseStorageOptions {
  /** The project URL, for example `https://<project-ref>.supabase.co`. */
  url: string;
  /** The key of the restricted role `automations_watcher`. */
  key: string;
  fetch: FetchFn;
  now?: () => Date;
}

export interface SupabaseStorage extends StorageAdapter {
  /** Reads one row. It keeps the free Supabase project awake. */
  keepalive(): Promise<void>;
}

/** Makes a PostgREST filter such as `family_id=eq.<value>`. */
function filter(column: string, operator: string, value: string): string {
  return `${column}=${operator}.${encodeURIComponent(value)}`;
}

function toItem(row: Row): StoredItem {
  return {
    familyId: String(row.family_id),
    watcher: String(row.watcher),
    id: String(row.id),
    firstSeen: new Date(String(row.first_seen)),
  };
}

function toEntry(row: Row): OutboxEntry {
  return {
    key: String(row.key),
    familyId: String(row.family_id),
    chatId: String(row.chat_id),
    text: String(row.text),
    queuedAt: new Date(String(row.queued_at)),
    deliveredAt: row.delivered_at === null ? null : new Date(String(row.delivered_at)),
  };
}

function toFee(row: Row): Fee {
  return {
    id: String(row.id),
    familyId: String(row.family_id),
    childId: String(row.child_id),
    organizer: String(row.organizer),
    recipientName: String(row.recipient_name),
    nip: row.nip === null ? null : String(row.nip),
    account: String(row.account),
    title: String(row.title),
    dueDay: Number(row.due_day),
    notifyDay: Number(row.notify_day),
    reminderDay: Number(row.reminder_day),
    amounts: row.amounts as Record<string, number>,
    sourceUrl: row.source_url === null ? null : String(row.source_url),
    accountId: row.account_id === null ? null : String(row.account_id),
    enabled: Boolean(row.enabled),
  };
}

const toDate = (value: unknown): Date | null => (value === null ? null : new Date(String(value)));

function toPayment(row: Row): Payment {
  return {
    id: String(row.id),
    familyId: String(row.family_id),
    feeId: String(row.fee_id),
    month: String(row.month),
    amount: Number(row.amount),
    amountSource: row.amount_source as Payment["amountSource"],
    status: row.status as Payment["status"],
    notifiedAt: toDate(row.notified_at),
    remindedAt: toDate(row.reminded_at),
    decidedAt: toDate(row.decided_at),
    decidedBy: row.decided_by === null ? null : String(row.decided_by),
    createdAt: new Date(String(row.created_at)),
  };
}

function toPaymentRow(payment: NewPayment): Row {
  return {
    family_id: payment.familyId,
    fee_id: payment.feeId,
    month: payment.month,
    amount: payment.amount,
    amount_source: payment.amountSource,
  };
}

/** PostgREST returns times as "HH:MM:SS". The config uses "HH:MM". */
function toActivity(row: Row): Row {
  return { ...row, start_time: String(row.start_time).slice(0, 5), end_time: String(row.end_time).slice(0, 5) };
}

/** StorageAdapter on top of the PostgREST API of Supabase. It uses plain fetch. */
export function createSupabaseStorage(options: SupabaseStorageOptions): SupabaseStorage {
  const base = `${options.url.replace(/\/+$/, "")}/rest/v1`;
  const now = options.now ?? (() => new Date());
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    apikey: options.key,
    authorization: `Bearer ${options.key}`,
    ...extra,
  });

  async function request(method: string, table: string, query: string, init: RequestInit = {}): Promise<Response> {
    const response = await options.fetch(`${base}/${table}?${query}`, { ...init, method });
    if (!response.ok) {
      throw new Error(`Supabase ${method} ${table} failed: ${response.status} ${await response.text()}`);
    }
    return response;
  }

  const select = async (table: string, query: string): Promise<Row[]> =>
    (await (await request("GET", table, query, { headers: headers() })).json()) as Row[];

  /** Inserts rows and returns the rows that are new. */
  async function insertNew(table: string, conflict: string, rows: Row[]): Promise<Row[]> {
    const init = { headers: headers({ ...JSON_HEADERS, prefer: INSERT_NEW }), body: JSON.stringify(rows) };
    return (await (await request("POST", table, `on_conflict=${conflict}`, init)).json()) as Row[];
  }

  const itemQuery = (familyId: string, watcher: string): string =>
    `${filter("family_id", "eq", familyId)}&${filter("watcher", "eq", watcher)}&order=first_seen.asc`;

  const listItems = async (familyId: string, watcher: string): Promise<StoredItem[]> =>
    (await select("items", itemQuery(familyId, watcher))).map(toItem);

  async function loadConfig(familyId: string): Promise<Config> {
    const family = (await select("families", filter("id", "eq", familyId)))[0];
    if (!family) throw new Error(`Family ${familyId} has no config`);
    const byFamily = filter("family_id", "eq", familyId);
    const [children, accounts, activities, recipients] = await Promise.all(
      ["children", "accounts", "activities", "recipients"].map((table) => select(table, byFamily)),
    );
    return {
      family,
      children,
      accounts,
      activities: (activities ?? []).map(toActivity),
      recipients,
    } as unknown as Config;
  }

  async function upsertPayment(payment: NewPayment): Promise<Payment> {
    const [added] = await insertNew("payments", "fee_id,month", [toPaymentRow(payment)]);
    if (added) return toPayment(added);
    const query = `${filter("fee_id", "eq", payment.feeId)}&${filter("month", "eq", payment.month)}`;
    const [existing] = await select("payments", query);
    if (!existing) throw new Error(`Payment ${payment.feeId} ${payment.month} was not saved`);
    return toPayment(existing);
  }

  return {
    keepalive: async () => {
      await select("families", "select=id&limit=1");
    },
    knownItemIds: async (familyId, watcher) => new Set((await listItems(familyId, watcher)).map((item) => item.id)),
    listItems,
    recordItems: async (familyId, watcher, ids) => {
      const unique = [...new Set(ids)];
      if (unique.length === 0) return 0;
      const rows = unique.map((id) => ({ family_id: familyId, watcher, id }));
      return (await insertNew("items", "family_id,watcher,id", rows)).length;
    },
    enqueueNotification: async (entry: NewNotification) => {
      const row = { key: entry.key, family_id: entry.familyId, chat_id: entry.chatId, text: entry.text };
      return (await insertNew("outbox", "key", [row])).length > 0;
    },
    pendingNotifications: async (familyId) =>
      (await select("outbox", `${filter("family_id", "eq", familyId)}&delivered_at=is.null&order=queued_at.asc`)).map(
        toEntry,
      ),
    markDelivered: async (key) => {
      const init = { headers: headers(JSON_HEADERS), body: JSON.stringify({ delivered_at: now().toISOString() }) };
      await request("PATCH", "outbox", `${filter("key", "eq", key)}&delivered_at=is.null`, init);
    },
    purgeDelivered: async (olderThanDays) => {
      const limit = new Date(now().getTime() - olderThanDays * DAY_MS).toISOString();
      const init = { headers: headers({ prefer: "return=representation" }) };
      const removed = await request("DELETE", "outbox", filter("delivered_at", "lt", limit), init);
      return ((await removed.json()) as Row[]).length;
    },
    loadConfig,
    listFees: async (familyId) => (await select("fees", filter("family_id", "eq", familyId))).map(toFee),
    upsertPayment,
    listPayments: async (familyId) =>
      (await select("payments", `${filter("family_id", "eq", familyId)}&order=created_at.asc`)).map(toPayment),
    setPaymentStatus: async (id, status, decidedBy) => {
      const body = JSON.stringify({ status, decided_by: decidedBy, decided_at: now().toISOString() });
      const init = { headers: headers({ ...JSON_HEADERS, prefer: "return=representation" }), body };
      const query = `${filter("id", "eq", id)}&status=eq.pending`;
      return ((await (await request("PATCH", "payments", query, init)).json()) as Row[]).length > 0;
    },
  };
}

/**
 * Creates the storage with the secret `SUPABASE_KEY`. The project URL is plain config: pass it, or it is read from
 * the secret `SUPABASE_URL` (local runs only; on Kody a secret cannot be part of a URL).
 */
export async function supabaseStorageFromRuntime(runtime: Runtime, url?: string): Promise<SupabaseStorage> {
  return createSupabaseStorage({
    url: url ?? (await runtime.secret("SUPABASE_URL")),
    key: await runtime.secret("SUPABASE_KEY"),
    fetch: runtime.fetch,
    now: () => runtime.now(),
  });
}
