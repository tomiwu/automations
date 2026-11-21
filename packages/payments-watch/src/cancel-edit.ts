/**
 * Payments contract v0.2 section 3b (PC4): when a Payment is cancelled, the QR messages that were sent for it
 * lose the Paid and Skip buttons and show that the Payment is cancelled. For an Organizer void or withdrawal,
 * one short new message also goes out, because money can leave the bank without a Paid press.
 *
 * The message IDs are a delivery field of the Outbox (`sentMessages`), not Journal data. One Outbox key for each
 * cancel (the stream and the `seq` of the `PaymentCancelled` event) and Recipient makes a repeated run do nothing.
 */
import { paymentStream, type Fee, type JournalEvent, type OutboxEntry, type Payment, type StorageAdapter } from "@automations/librus-data";
import { t, type Config, type MessageKey, type Recipient } from "@automations/shared";
import type { TelegramClient } from "./notifier.ts";
import { PAYMENT_KEY } from "./sent-journal.ts";

export interface CancelEditDeps {
  storage: StorageAdapter;
  familyId: string;
  client: TelegramClient;
  log?: (message: string) => void;
}

const REASONS = ["fee_disabled", "organizer_void", "organizer_withdrawn"] as const;
type Reason = (typeof REASONS)[number];

interface Cancelled {
  payment: Payment;
  fee: Fee;
  seq: number;
  reason: Reason;
}

interface Target extends Cancelled {
  recipient: Recipient;
  messageIds: number[];
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function reasonOf(head: JournalEvent | undefined): Reason | undefined {
  if (head?.eventType !== "PaymentCancelled") return undefined;
  return REASONS.find((reason) => reason === head.payload.cancelReason);
}

function cancelledOf(payment: Payment, fees: Fee[], heads: JournalEvent[]): Cancelled | undefined {
  const fee = fees.find((candidate) => candidate.id === payment.feeId);
  const head = fee && heads.find((event) => event.stream === paymentStream(fee.childId, fee.id, payment.month));
  const reason = reasonOf(head);
  return fee && head && reason ? { payment, fee, seq: head.seq, reason } : undefined;
}

const paymentIdOf = (key: string): string => PAYMENT_KEY.exec(key)?.[1] ?? "";

/** The cancelled Payment and the Recipient of one stored message, or undefined when it has no cancel or no Recipient. */
function baseOf(entry: OutboxEntry, cancelled: Map<string, Cancelled>, config: Config): Target | undefined {
  const subject = cancelled.get(paymentIdOf(entry.key));
  const recipient = config.recipients.find((candidate) => candidate.telegram_chat_id === entry.chatId);
  return subject && recipient ? { ...subject, recipient, messageIds: [] } : undefined;
}

/** The stored QR messages of the cancelled Payments, grouped by Payment and chat. */
function targetsOf(messages: OutboxEntry[], cancelled: Map<string, Cancelled>, config: Config): Target[] {
  const targets = new Map<string, Target>();
  for (const entry of messages) {
    const base = baseOf(entry, cancelled, config);
    if (!base || entry.messageId === null) continue;
    const slot = `${base.payment.id}:${entry.chatId}`;
    targets.set(slot, withMessage(targets.get(slot) ?? base, entry.messageId));
  }
  return [...targets.values()];
}

const withMessage = (target: Target, messageId: number): Target => ({ ...target, messageIds: [...target.messageIds, messageId] });

async function edit(deps: CancelEditDeps, target: Target, messageId: number): Promise<void> {
  const { recipient, reason } = target;
  const reasonText = t(recipient.language, `payment.cancelled.reason.${reason}` satisfies MessageKey);
  try {
    await deps.client.call("editMessageCaption", {
      chat_id: recipient.telegram_chat_id,
      message_id: messageId,
      caption: t(recipient.language, "payment.cancelled.caption", { reason: reasonText }),
      reply_markup: { inline_keyboard: [] },
    });
  } catch (error) {
    deps.log?.(`cancel edit: message ${messageId} of payment ${target.payment.id} not edited (${messageOf(error)})`);
  }
}

async function notice(deps: CancelEditDeps, target: Target, config: Config, base: string): Promise<void> {
  if (target.reason === "fee_disabled") return;
  const child = config.children.find((candidate) => candidate.id === target.fee.childId);
  await deps.storage.enqueueNotification({
    key: `cancel-notice:${base}`,
    familyId: deps.familyId,
    chatId: target.recipient.telegram_chat_id,
    text: t(target.recipient.language, "payment.cancelled.notice", {
      child: child?.name ?? "",
      organizer: target.fee.organizer,
      month: target.payment.month,
    }),
  });
}

async function handle(deps: CancelEditDeps, target: Target, config: Config): Promise<void> {
  const base = `${target.payment.id}:${target.seq}:${target.recipient.telegram_chat_id}`;
  const key = `cancel-edit:${base}`;
  const added = await deps.storage.enqueueNotification({ key, familyId: deps.familyId, chatId: target.recipient.telegram_chat_id, text: key });
  if (!added) return;
  await deps.storage.markDelivered(key);
  for (const messageId of target.messageIds) await edit(deps, target, messageId);
  await notice(deps, target, config, base);
}

/**
 * Edits the sent QR messages of each cancelled Payment once, and queues the one new message for an Organizer cancel.
 * The new message goes out with the next text delivery. A failed edit is logged and never undoes the cancel.
 * A Payment with no stored message ID gets nothing.
 */
export async function editCancelledMessages(deps: CancelEditDeps): Promise<void> {
  const { storage, familyId } = deps;
  const payments = (await storage.listPayments(familyId)).filter((payment) => payment.status === "cancelled");
  if (payments.length === 0) return;
  const [messages, fees, heads, config] = await Promise.all([
    storage.sentMessages(familyId),
    storage.listFees(familyId),
    storage.listHeads(familyId, { kinds: ["payment"] }),
    storage.loadConfig(familyId),
  ]);
  const cancelled = new Map(payments.flatMap((payment) => {
    const found = cancelledOf(payment, fees, heads);
    return found ? [[payment.id, found] as const] : [];
  }));
  for (const target of targetsOf(messages, cancelled, config)) await handle(deps, target, config);
}
