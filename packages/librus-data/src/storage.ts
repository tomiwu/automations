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

/** One recurring charge of one Organizer for one Child. The Watcher reads it and never changes it. */
export interface Fee {
  id: string;
  familyId: string;
  childId: string;
  organizer: string;
  recipientName: string;
  nip: string | null;
  account: string;
  title: string;
  dueDay: number;
  notifyDay: number;
  reminderDay: number;
  /** Month `YYYY-MM` to amount in grosze. */
  amounts: Record<string, number>;
  sourceUrl: string | null;
  accountId: string | null;
  enabled: boolean;
}

export type PaymentStatus = "pending" | "paid" | "skipped";
export type AmountSource = "page" | "config";

/** The data to make one Payment. The status is `pending`. */
export interface NewPayment {
  familyId: string;
  feeId: string;
  month: string;
  /** Grosze. */
  amount: number;
  amountSource: AmountSource;
}

/** One Fee for one month. */
export interface Payment extends NewPayment {
  id: string;
  status: PaymentStatus;
  notifiedAt: Date | null;
  remindedAt: Date | null;
  decidedAt: Date | null;
  decidedBy: string | null;
  createdAt: Date;
}

/** Items, the Outbox, Fees, Payments and config reads. */

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
  listFees(familyId: string): Promise<Fee[]>;
  /** Makes a `pending` Payment. A Payment for the same Fee and month is not changed and is returned as it is. */
  upsertPayment(payment: NewPayment): Promise<Payment>;
  /** Payments of the Family, oldest first. */
  listPayments(familyId: string): Promise<Payment[]>;
  /** Sets the status, `decidedAt` and `decidedBy` of a `pending` Payment. Returns false if nothing changed. */
  setPaymentStatus(
    id: string,
    status: Exclude<PaymentStatus, "pending">,
    decidedBy: string,
  ): Promise<boolean>;
}
