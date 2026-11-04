import { randomUUID } from "node:crypto";
import type { Config } from "@automations/shared";
import type { Fee, NewNotification, OutboxEntry, Payment, StorageAdapter, StoredItem } from "./storage.ts";

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
  const outbox = new Map<string, OutboxEntry>();
  const configs = new Map<string, Config>();
  const fees = new Map<string, Fee>();
  const payments = new Map<string, Payment>();
  const setConfig = (config: Config): void => {
    configs.set(config.family.id, config);
  };
  options.configs?.forEach(setConfig);

  const itemsOf = (familyId: string, watcher: string): StoredItem[] =>
    [...items.values()].filter((item) => item.familyId === familyId && item.watcher === watcher);

  return {
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
    enqueueNotification: async (entry: NewNotification) => {
      if (outbox.has(entry.key)) return false;
      outbox.set(entry.key, { ...entry, queuedAt: now(), deliveredAt: null });
      return true;
    },
    enqueueNotifications: async (entries) => {
      let added = 0;
      for (const entry of entries) {
        if (outbox.has(entry.key)) continue;
        outbox.set(entry.key, { ...entry, queuedAt: now(), deliveredAt: null });
        added += 1;
      }
      return added;
    },
    pendingNotifications: async (familyId) =>
      [...outbox.values()].filter((entry) => entry.familyId === familyId && entry.deliveredAt === null),
    markDelivered: async (key) => {
      const entry = outbox.get(key);
      if (entry && entry.deliveredAt === null) entry.deliveredAt = now();
    },
    markDeliveredMany: async (keys) => {
      for (const key of keys) {
        const entry = outbox.get(key);
        if (entry && entry.deliveredAt === null) entry.deliveredAt = now();
      }
    },
    purgeDelivered: async (olderThanDays) => {
      const limit = now().getTime() - olderThanDays * DAY_MS;
      let removed = 0;
      for (const [key, entry] of outbox) {
        if (entry.deliveredAt !== null && entry.deliveredAt.getTime() < limit) {
          outbox.delete(key);
          removed += 1;
        }
      }
      return removed;
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
        createdAt: now(),
      };
      payments.set(made.id, made);
      return { ...made };
    },
    listPayments: async (familyId) =>
      [...payments.values()].filter((payment) => payment.familyId === familyId).map((payment) => ({ ...payment })),
    setPaymentStatus: async (id, status, decidedBy) => {
      const payment = payments.get(id);
      if (!payment || payment.status !== "pending") return false;
      Object.assign(payment, { status, decidedBy, decidedAt: now() });
      return true;
    },
  };
}
