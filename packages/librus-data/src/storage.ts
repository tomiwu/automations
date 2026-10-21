import type { Config } from "@automations/shared";

/** One fact that a Watcher saw. */
export interface StoredItem {
  familyId: string;
  watcher: string;
  id: string;
  firstSeen: Date;
}

/** One Notification for one Recipient. The `key` includes the chat ID. */
export interface NewNotification {
  key: string;
  familyId: string;
  chatId: string;
  text: string;
}

export interface OutboxEntry extends NewNotification {
  queuedAt: Date;
  deliveredAt: Date | null;
}

/** Items, the Outbox and config reads. */
export interface StorageAdapter {
  knownItemIds(familyId: string, watcher: string): Promise<Set<string>>;
  listItems(familyId: string, watcher: string): Promise<StoredItem[]>;
  /** Records the IDs that are new. Returns the number of new Items. */
  recordItems(familyId: string, watcher: string, ids: readonly string[]): Promise<number>;
  /** Idempotent on `key`. Returns true if the entry is new. */
  enqueueNotification(entry: NewNotification): Promise<boolean>;
  pendingNotifications(familyId: string): Promise<OutboxEntry[]>;
  markDelivered(key: string): Promise<void>;
  /** Removes entries delivered more than `olderThanDays` days ago. Returns the number removed. */
  purgeDelivered(olderThanDays: number): Promise<number>;
  loadConfig(familyId: string): Promise<Config>;
}
