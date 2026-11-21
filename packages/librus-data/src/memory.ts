import { randomUUID } from "node:crypto";
import type { Config } from "@automations/shared";
import { appendItemEvents, detailSlot, detailsOfEvents, ITEM_KINDS, uniqueDetails } from "./details.ts";
import { matchesJournalFilter } from "./journal.ts";
import type { Fee, ItemDetail, JournalEvent, JournalFilter, NewNotification, OutboxEntry, Payment, StorageAdapter, StoredItem } from "./storage.ts";

const DAY_MS = 86_400_000;

export interface MemoryStorageOptions {
  now?: () => Date;
  configs?: readonly Config[];
}

export interface MemoryStorage extends StorageAdapter {
  setConfig(config: Config): void;
  setFee(fee: Fee): void;
}

/** In-memory StorageAdapter for tests. It uses no network. */
export function createMemoryStorage(options: MemoryStorageOptions = {}): MemoryStorage {
  const now = options.now ?? (() => new Date());
  const items = new Map<string, StoredItem>();
  const details = new Map<string, ItemDetail>();
  const journal: JournalEvent[] = [];
  const journalKey = (event: { familyId: string; stream: string; seq: number }): string =>
    JSON.stringify([event.familyId, event.stream, event.seq]);
  const journalOf = (familyId: string, filter: JournalFilter): JournalEvent[] =>
    journal.filter((event) => event.familyId === familyId && matchesJournalFilter(event, filter));
  const outbox = new Map<string, OutboxEntry>();
  const attachments = new Map<string, Uint8Array>();
  /** Queues the entry unless its key exists. Returns true if the entry is new. */
  const enqueue = (entry: NewNotification): boolean => {
    if (outbox.has(entry.key)) return false;
    const kind = entry.kind ?? "text";
    outbox.set(entry.key, {
      ...entry,
      kind,
      queuedAt: now(),
      deliveredAt: null,
      messageId: null,
    });
    return true;
  };
  const deliver = (key: string): void => {
    const entry = outbox.get(key);
    if (entry && entry.deliveredAt === null) entry.deliveredAt = now();
  };
  const configs = new Map<string, Config>();
  const fees = new Map<string, Fee>();
  const payments = new Map<string, Payment>();
  const setConfig = (config: Config): void => {
    configs.set(config.family.id, config);
  };
  options.configs?.forEach(setConfig);

  const itemsOf = (familyId: string, watcher: string): StoredItem[] =>
    [...items.values()].filter((item) => item.familyId === familyId && item.watcher === watcher);

  const storage: MemoryStorage = {
    setConfig,
    setFee: (fee) => {
      fees.set(fee.id, fee);
    },
    knownItemIds: async (familyId, watcher) => new Set(itemsOf(familyId, watcher).map((item) => item.id)),
    listItems: async (familyId, watcher) => itemsOf(familyId, watcher),
    recordItems: async (familyId, watcher, ids) => {
      let added = 0;
      for (const id of ids) {
        const slot = JSON.stringify([familyId, watcher, id]);
        if (items.has(slot)) continue;
        items.set(slot, { familyId, watcher, id, firstSeen: now() });
        added += 1;
      }
      return added;
    },
    recordDetails: async (rows) => {
      let added = 0;
      for (const { row, hash } of await uniqueDetails(rows)) {
        const slot = detailSlot(row, hash);
        if (details.has(slot)) continue;
        details.set(slot, { ...row, firstSeen: now() });
        added += 1;
      }
      await appendItemEvents(storage, rows);
      return added;
    },
    listDetails: async (familyId, filter = {}) =>
      detailsOfEvents(journalOf(familyId, { ...filter, kinds: ITEM_KINDS }).map((event) => structuredClone(event))),
    appendEvents: async (events) => {
      const keys = new Set(journal.map(journalKey));
      for (const event of events) {
        if (keys.has(journalKey(event))) throw new Error(`Journal event ${event.stream} ${event.seq} exists already`);
        keys.add(journalKey(event));
      }
      const recordedAt = now();
      journal.push(...events.map((event) => structuredClone({ ...event, recordedAt })));
      return events.length;
    },
    listHeads: async (familyId, filter = {}) => {
      const last = new Map<string, JournalEvent>();
      for (const event of journal.filter((other) => other.familyId === familyId)) {
        const head = last.get(event.stream);
        if (!head || head.seq < event.seq) last.set(event.stream, event);
      }
      return [...last.values()].filter((event) => matchesJournalFilter(event, filter)).map((event) => structuredClone(event));
    },
    listEvents: async (familyId, filter = {}) =>
      journalOf(familyId, filter)
        .sort((a, b) => (a.stream === b.stream ? a.seq - b.seq : a.stream < b.stream ? -1 : 1))
        .map((event) => structuredClone(event)),
    enqueueNotification: async (entry: NewNotification) => enqueue(entry),
    enqueueNotifications: async (entries) => entries.filter(enqueue).length,
    pendingNotifications: async (familyId) =>
      [...outbox.values()].filter((entry) => entry.familyId === familyId && entry.deliveredAt === null),
    markDelivered: async (key) => deliver(key),
    recordMessageId: async (key, messageId) => {
      const entry = outbox.get(key);
      if (entry) entry.messageId = messageId;
    },
    sentMessages: async (familyId) =>
      [...outbox.values()].filter((entry) => entry.familyId === familyId && entry.messageId !== null).map((entry) => ({ ...entry })),
    markDeliveredMany: async (keys) => keys.forEach(deliver),
    putAttachment: async (path, bytes, _contentType) => {
      attachments.set(path, bytes);
    },
    getAttachment: async (path) => {
      const bytes = attachments.get(path);
      if (!bytes) throw new Error(`Attachment ${path} is missing`);
      return bytes;
    },
    loadConfig: async (familyId) => {
      const config = configs.get(familyId);
      if (!config) throw new Error(`Family ${familyId} has no config`);
      return config;
    },
    listFees: async (familyId) => [...fees.values()].filter((fee) => fee.familyId === familyId),
    upsertPayment: async (payment) => {
      const existing = [...payments.values()].find(
        (other) => other.feeId === payment.feeId && other.month === payment.month,
      );
      if (existing) return { ...existing };
      const made: Payment = {
        ...payment,
        id: randomUUID(),
        status: "pending",
        notifiedAt: null,
        remindedAt: null,
        decidedAt: null,
        decidedBy: null,
        refundCheckAt: null,
        createdAt: now(),
      };
      payments.set(made.id, made);
      return { ...made };
    },
    listPayments: async (familyId) =>
      [...payments.values()].filter((payment) => payment.familyId === familyId).map((payment) => ({ ...payment })),
    updatePendingAmount: async (id, amount, amountSource) => {
      const payment = payments.get(id);
      if (!payment || payment.status !== "pending") return false;
      Object.assign(payment, { amount, amountSource });
      return true;
    },
    markPaymentSent: async (id, which, at) => {
      const payment = payments.get(id);
      const field = which === "notified" ? "notifiedAt" : "remindedAt";
      if (!payment || payment.status !== "pending" || payment[field] !== null) return false;
      payment[field] = at;
      return true;
    },
    setPaymentStatus: async (id, status, decidedBy) => {
      const payment = payments.get(id);
      if (!payment || payment.status !== "pending") return false;
      Object.assign(payment, { status, decidedBy, decidedAt: now() });
      return true;
    },
    cancelPendingPayment: async (id) => {
      const payment = payments.get(id);
      if (!payment || payment.status !== "pending") return false;
      payment.status = "cancelled";
      return true;
    },
    flagRefundCheck: async (id, at) => {
      const payment = payments.get(id);
      if (!payment || payment.status !== "paid" || payment.refundCheckAt !== null) return false;
      payment.refundCheckAt = at;
      return true;
    },
    reopenCancelledPayment: async (id) => {
      const payment = payments.get(id);
      if (!payment || payment.status !== "cancelled") return false;
      payment.status = "pending";
      return true;
    },
  };
  return storage;
}
