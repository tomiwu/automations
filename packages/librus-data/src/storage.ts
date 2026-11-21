import type { Config } from "@automations/shared";

/** One fact that a Watcher saw. */
export interface StoredItem {
  familyId: string;
  watcher: string;
  id: string;
  firstSeen: Date;
}

export type ItemKind = "meeting" | "dayOff" | "trip" | "terminarz" | "announcement" | "message" | "grade";

/** The content of one Item. `scope` is the Watcher name of the Item, for example `messages:<childId>`. */
export interface NewItemDetail {
  familyId: string;
  scope: string;
  kind: ItemKind;
  childId: string;
  sourceId: string;
  /** `YYYY-MM-DD`. */
  date: string | null;
  /** `HH:MM`. */
  startTime: string | null;
  endTime: string | null;
  title: string;
  /** The whole text. */
  text: string;
  sender: string | null;
  subject: string | null;
  category: string | null;
  sourceUpdatedAt: Date | null;
}

/** A stored `NewItemDetail`. It is kept forever. */
export interface ItemDetail extends NewItemDetail {
  firstSeen: Date;
}

export interface DetailFilter {
  childId?: string;
  /** First day, `YYYY-MM-DD`, included. */
  from?: string;
  /** Last day, `YYYY-MM-DD`, included. */
  to?: string;
  /** Only rows that were first seen at or after this time. */
  since?: Date;
}

export type JournalKind = "lesson" | "homework" | "session" | "check" | "payment" | "attachment" | ItemKind;

export type OutboxKind = "text" | "document";

/** One Journal event to append. The payload is the full new state of the entity. */
export interface NewJournalEvent {
  familyId: string;
  childId: string;
  stream: string;
  /** Starts at 1 and grows by 1 in each stream. */
  seq: number;
  kind: JournalKind;
  /** `YYYY-MM-DD`. */
  day: string | null;
  eventType: string;
  payload: Record<string, unknown>;
  contentHash: string;
  /** `librus-watch`, `activities-watch` or `backfill-0008`. */
  source: string;
}

/** A stored Journal event. It is never changed or removed. */
export interface JournalEvent extends NewJournalEvent {
  recordedAt: Date;
}

export interface JournalFilter {
  childId?: string;
  kinds?: readonly JournalKind[];
  /** First `day`, `YYYY-MM-DD`, included. An event with no day does not match. */
  from?: string;
  /** Last `day`, included. */
  to?: string;
  /** First `day` after the range, not included (half-open range). Use `monthRange` for a month. */
  before?: string;
  streams?: readonly string[];
  /** Only events recorded at or after this time. */
  since?: Date;
}

/** One Notification for one Recipient. The `key` includes the chat ID. */
export interface NewNotification {
  key: string;
  familyId: string;
  chatId: string;
  kind?: OutboxKind;
  text: string;
  /** Set when `kind` is `document`. */
  storagePath?: string;
  fileName?: string;
}

export interface OutboxEntry extends NewNotification {
  kind: OutboxKind;
  queuedAt: Date;
  deliveredAt: Date | null;
  /** The Telegram message ID of the message that was sent for this entry, or null (not sent, or sent before it was stored). */
  messageId: number | null;
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

/** `cancelled` comes from `PaymentCancelled` (payments contract v0.2): never from a human decision. */
export type PaymentStatus = "pending" | "paid" | "skipped" | "cancelled";
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
  /** When payments-watch saw that the Organizer no longer lists this `paid` charge. Null when not flagged. */
  refundCheckAt: Date | null;
  createdAt: Date;
}

/** Items, the Outbox, Fees, Payments and config reads. */
export interface StorageAdapter {
  knownItemIds(familyId: string, watcher: string): Promise<Set<string>>;
  listItems(familyId: string, watcher: string): Promise<StoredItem[]>;
  /** Records the IDs that are new. Returns the number of new Items. */
  recordItems(familyId: string, watcher: string, ids: readonly string[]): Promise<number>;
  /**
   * Stores the content of Items. A row with the same Family, scope, source ID and content is not stored again.
   * Changed content adds a new row; the old row stays. Returns the number of new rows.
   */
  recordDetails(rows: readonly NewItemDetail[]): Promise<number>;
  /** Details of the Family, oldest first. */
  listDetails(familyId: string, filter?: DetailFilter): Promise<ItemDetail[]>;
  /**
   * Appends Journal events in batches. A key `(familyId, stream, seq)` that exists already rejects the batch.
   * Returns the number of events. There is no method that changes or removes an event.
   */
  appendEvents(events: readonly NewJournalEvent[]): Promise<number>;
  /** The last event of each stream. */
  listHeads(familyId: string, filter?: JournalFilter): Promise<JournalEvent[]>;
  /** Events ordered by stream and `seq`. */
  listEvents(familyId: string, filter?: JournalFilter): Promise<JournalEvent[]>;
  /** Idempotent on `key`. Returns true if the entry is new. */
  enqueueNotification(entry: NewNotification): Promise<boolean>;
  /** Like `enqueueNotification` for many entries in one request. Returns the number of new entries. */
  enqueueNotifications(entries: readonly NewNotification[]): Promise<number>;
  pendingNotifications(familyId: string): Promise<OutboxEntry[]>;
  markDelivered(key: string): Promise<void>;
  /** Stores the Telegram message ID of the message that was sent for the entry. It is a delivery field, not Journal data. */
  recordMessageId(key: string, messageId: number): Promise<void>;
  /** The entries of the Family that have a stored Telegram message ID, oldest first. */
  sentMessages(familyId: string): Promise<OutboxEntry[]>;
  /** Like `markDelivered` for many keys in one request. */
  markDeliveredMany(keys: readonly string[]): Promise<void>;
  /** Stores one file in the private `librus-attachments` bucket. The path is `<family_id>/<message_id>/<attachment_id>`. */
  putAttachment(path: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /** Reads one stored attachment. It rejects when the file is missing. */
  getAttachment(path: string): Promise<Uint8Array>;
  loadConfig(familyId: string): Promise<Config>;
  listFees(familyId: string): Promise<Fee[]>;
  /** Makes a `pending` Payment. A Payment for the same Fee and month is not changed and is returned as it is. */
  upsertPayment(payment: NewPayment): Promise<Payment>;
  /** Payments of the Family, oldest first. */
  listPayments(familyId: string): Promise<Payment[]>;
  /** Sets `amount` and `amountSource` of a `pending` Payment. Returns false if nothing changed. */
  updatePendingAmount(id: string, amount: number, amountSource: AmountSource): Promise<boolean>;
  /** Sets `notifiedAt` or `remindedAt` of a `pending` Payment that has no such time yet. Returns false if nothing changed. */
  markPaymentSent(id: string, which: "notified" | "reminded", at: Date): Promise<boolean>;
  /** Sets the status, `decidedAt` and `decidedBy` of a `pending` Payment. Returns false if nothing changed. */
  setPaymentStatus(
    id: string,
    status: Exclude<PaymentStatus, "pending" | "cancelled">,
    decidedBy: string,
  ): Promise<boolean>;
  /** Sets the status of a `pending` Payment to `cancelled`. `decidedAt` and `decidedBy` stay. Returns false if nothing changed. */
  cancelPendingPayment(id: string): Promise<boolean>;
  /** Sets `refundCheckAt` of a `paid` Payment that has no such time yet. The status stays. Returns false if nothing changed. */
  flagRefundCheck(id: string, at: Date): Promise<boolean>;
  /** Sets the status of a `cancelled` Payment back to `pending`. Returns false if nothing changed. */
  reopenCancelledPayment(id: string): Promise<boolean>;
}
