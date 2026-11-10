import type { Config, FetchFn, Runtime } from "@automations/shared";
import { appendItemEvents, DETAIL_BATCH_SIZE, detailsFromJournal, uniqueDetails } from "./details.ts";
import type { Fee, JournalEvent, JournalFilter, NewJournalEvent, NewItemDetail, NewNotification, NewPayment, OutboxEntry, Payment, StorageAdapter, StoredItem } from "./storage.ts";

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
    messageId: row.message_id === null || row.message_id === undefined ? null : Number(row.message_id),
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

const orNull = (value: unknown): string | null => (value === null ? null : String(value));

function toDetailRow(detail: NewItemDetail, hash: string): Row {
  return {
    family_id: detail.familyId,
    scope: detail.scope,
    kind: detail.kind,
    child_id: detail.childId,
    source_id: detail.sourceId,
    content_hash: hash,
    date: detail.date,
    start_time: detail.startTime,
    end_time: detail.endTime,
    title: detail.title,
    text: detail.text,
    sender: detail.sender,
    subject: detail.subject,
    category: detail.category,
    source_updated_at: detail.sourceUpdatedAt?.toISOString() ?? null,
  };
}

function toJournalRow(event: NewJournalEvent): Row {
  return {
    family_id: event.familyId,
    child_id: event.childId,
    stream: event.stream,
    seq: event.seq,
    kind: event.kind,
    day: event.day,
    event_type: event.eventType,
    payload: event.payload,
    content_hash: event.contentHash,
    source: event.source,
  };
}

function toJournalEvent(row: Row): JournalEvent {
  return {
    familyId: String(row.family_id),
    childId: String(row.child_id),
    stream: String(row.stream),
    seq: Number(row.seq),
    kind: row.kind as JournalEvent["kind"],
    day: orNull(row.day),
    eventType: String(row.event_type),
    payload: row.payload as Record<string, unknown>,
    contentHash: String(row.content_hash),
    source: String(row.source),
    recordedAt: new Date(String(row.recorded_at)),
  };
}

/** A PostgREST list such as `("a","b")`, URL-encoded. */
const inList = (values: readonly string[]): string =>
  encodeURIComponent(`(${values.map((value) => `"${value.replace(/(["\\])/g, "\\$1")}"`).join(",")})`);

function journalQuery(familyId: string, where: JournalFilter): string[] {
  const optional: [string | undefined, string][] = [
    [where.childId, "child_id=eq."],
    [where.from, "day=gte."],
    [where.to, "day=lte."],
    [where.before, "day=lt."],
    [where.since?.toISOString(), "recorded_at=gte."],
  ];
  const parts = optional.flatMap(([value, prefix]) => (value === undefined ? [] : [prefix + encodeURIComponent(value)]));
  if (where.kinds !== undefined) parts.push(`kind=in.${inList(where.kinds)}`);
  return [filter("family_id", "eq", familyId), ...parts];
}

/** The streams of a filter in groups of at most `DETAIL_BATCH_SIZE`. One group with no stream filter if unset. */
function streamGroups(streams: readonly string[] | undefined): (readonly string[] | undefined)[] {
  if (streams === undefined) return [undefined];
  const groups: string[][] = [];
  for (let start = 0; start < streams.length; start += DETAIL_BATCH_SIZE) groups.push(streams.slice(start, start + DETAIL_BATCH_SIZE));
  return groups;
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

  /** Patches the Payments that match the query. Returns true if a row changed. */
  async function patchPayment(query: string, body: Record<string, unknown>): Promise<boolean> {
    const init = { headers: headers({ ...JSON_HEADERS, prefer: "return=representation" }), body: JSON.stringify(body) };
    return ((await (await request("PATCH", "payments", query, init)).json()) as Row[]).length > 0;
  }

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

  async function readJournal(table: string, order: string, familyId: string, where: JournalFilter): Promise<JournalEvent[]> {
    if (where.kinds?.length === 0) return [];
    const rows: JournalEvent[] = [];
    for (const group of streamGroups(where.streams)) {
      const parts = journalQuery(familyId, where);
      if (group !== undefined) parts.push(`stream=in.${inList(group)}`);
      rows.push(...(await select(table, `${parts.join("&")}&order=${order}`)).map(toJournalEvent));
    }
    return rows;
  }

  const itemQuery = (familyId: string, watcher: string): string =>
    `${filter("family_id", "eq", familyId)}&${filter("watcher", "eq", watcher)}&order=first_seen.asc`;

  const listItems = async (familyId: string, watcher: string): Promise<StoredItem[]> =>
    (await select("items", itemQuery(familyId, watcher))).map(toItem);

  /** One request: the Family with its Children, Accounts, Activities and Recipients embedded. */
  async function loadConfig(familyId: string): Promise<Config> {
    const embed = "select=*,children(*),accounts(*),activities(*),recipients(*)";
    const family = (await select("families", `${embed}&${filter("id", "eq", familyId)}`))[0];
    if (!family) throw new Error(`Family ${familyId} has no config`);
    const { children, accounts, activities, recipients, ...own } = family;
    return {
      family: own,
      children,
      accounts,
      activities: ((activities as Row[] | undefined) ?? []).map(toActivity),
      recipients,
    } as unknown as Config;
  }

  const outboxRow = (entry: NewNotification): Row => ({
    key: entry.key,
    family_id: entry.familyId,
    chat_id: entry.chatId,
    text: entry.text,
  });

  async function upsertPayment(payment: NewPayment): Promise<Payment> {
    const [added] = await insertNew("payments", "fee_id,month", [toPaymentRow(payment)]);
    if (added) return toPayment(added);
    const query = `${filter("fee_id", "eq", payment.feeId)}&${filter("month", "eq", payment.month)}`;
    const [existing] = await select("payments", query);
    if (!existing) throw new Error(`Payment ${payment.feeId} ${payment.month} was not saved`);
    return toPayment(existing);
  }

  const storage: SupabaseStorage = {
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
    recordDetails: async (rows) => {
      const unique = await uniqueDetails(rows);
      let added = 0;
      for (let start = 0; start < unique.length; start += DETAIL_BATCH_SIZE) {
        const batch = unique.slice(start, start + DETAIL_BATCH_SIZE).map(({ row, hash }) => toDetailRow(row, hash));
        added += (await insertNew("item_details", "family_id,scope,source_id,content_hash", batch)).length;
      }
      await appendItemEvents(storage, rows);
      return added;
    },
    listDetails: async (familyId, where = {}) => detailsFromJournal(storage, familyId, where),
    appendEvents: async (events) => {
      for (let start = 0; start < events.length; start += DETAIL_BATCH_SIZE) {
        const body = JSON.stringify(events.slice(start, start + DETAIL_BATCH_SIZE).map(toJournalRow));
        await request("POST", "journal_events", "", { headers: headers({ ...JSON_HEADERS, prefer: "return=minimal" }), body });
      }
      return events.length;
    },
    listHeads: async (familyId, where = {}) => readJournal("journal_heads", "stream.asc", familyId, where),
    listEvents: async (familyId, where = {}) => readJournal("journal_events", "stream.asc,seq.asc", familyId, where),
    enqueueNotification: async (entry: NewNotification) => (await insertNew("outbox", "key", [outboxRow(entry)])).length > 0,
    enqueueNotifications: async (entries) => {
      const unique = [...new Map(entries.map((entry) => [entry.key, entry])).values()];
      if (unique.length === 0) return 0;
      return (await insertNew("outbox", "key", unique.map(outboxRow))).length;
    },
    pendingNotifications: async (familyId) =>
      (await select("outbox", `${filter("family_id", "eq", familyId)}&delivered_at=is.null&order=queued_at.asc`)).map(
        toEntry,
      ),
    markDelivered: async (key) => {
      const init = { headers: headers(JSON_HEADERS), body: JSON.stringify({ delivered_at: now().toISOString() }) };
      await request("PATCH", "outbox", `${filter("key", "eq", key)}&delivered_at=is.null`, init);
    },
    recordMessageId: async (key, messageId) => {
      const init = { headers: headers(JSON_HEADERS), body: JSON.stringify({ message_id: messageId }) };
      await request("PATCH", "outbox", filter("key", "eq", key), init);
    },
    sentMessages: async (familyId) =>
      (await select("outbox", `${filter("family_id", "eq", familyId)}&message_id=not.is.null&order=queued_at.asc`)).map(toEntry),
    markDeliveredMany: async (keys) => {
      if (keys.length === 0) return;
      const list = keys.map((key) => `"${key.replace(/(["\\])/g, "\\$1")}"`).join(",");
      const init = { headers: headers(JSON_HEADERS), body: JSON.stringify({ delivered_at: now().toISOString() }) };
      await request("PATCH", "outbox", `key=in.(${encodeURIComponent(list)})&delivered_at=is.null`, init);
    },
    loadConfig,
    listFees: async (familyId) => (await select("fees", filter("family_id", "eq", familyId))).map(toFee),
    upsertPayment,
    listPayments: async (familyId) =>
      (await select("payments", `${filter("family_id", "eq", familyId)}&order=created_at.asc`)).map(toPayment),
    updatePendingAmount: async (id, amount, amountSource) =>
      patchPayment(`${filter("id", "eq", id)}&status=eq.pending`, {
        amount,
        amount_source: amountSource,
      }),
    markPaymentSent: async (id, which, at) => {
      const column = which === "notified" ? "notified_at" : "reminded_at";
      const query = `${filter("id", "eq", id)}&status=eq.pending&${column}=is.null`;
      return patchPayment(query, { [column]: at.toISOString() });
    },
    setPaymentStatus: async (id, status, decidedBy) => {
      const body = JSON.stringify({ status, decided_by: decidedBy, decided_at: now().toISOString() });
      const init = { headers: headers({ ...JSON_HEADERS, prefer: "return=representation" }), body };
      const query = `${filter("id", "eq", id)}&status=eq.pending`;
      return ((await (await request("PATCH", "payments", query, init)).json()) as Row[]).length > 0;
    },
    cancelPendingPayment: async (id) => {
      const init = { headers: headers({ ...JSON_HEADERS, prefer: "return=representation" }), body: JSON.stringify({ status: "cancelled" }) };
      const query = `${filter("id", "eq", id)}&status=eq.pending`;
      return ((await (await request("PATCH", "payments", query, init)).json()) as Row[]).length > 0;
    },
    reopenCancelledPayment: async (id) => {
      const init = { headers: headers({ ...JSON_HEADERS, prefer: "return=representation" }), body: JSON.stringify({ status: "pending" }) };
      const query = `${filter("id", "eq", id)}&status=eq.cancelled`;
      return ((await (await request("PATCH", "payments", query, init)).json()) as Row[]).length > 0;
    },
  };
  return storage;
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
