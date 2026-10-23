import type { Fee, Payment, StorageAdapter } from "@automations/librus-data";
import { t, type Config, type Language, type MessageKey, type Recipient } from "@automations/shared";
import type { TelegramClient } from "./notifier.ts";

const PREFIX = "pay:";
const ACTIONS = { paid: "paid", skip: "skipped" } as const;

/** One button press, read from a Telegram `callback_query`. */
export interface CallbackQuery {
  id: string;
  data: string;
  chatId: string;
  messageId: number;
  /** The caption of the message with the buttons. */
  caption?: string;
}

export interface CallbackDeps {
  familyId: string;
  storage: StorageAdapter;
  client: TelegramClient;
}

type Decision = (typeof ACTIONS)[keyof typeof ACTIONS];

interface Parsed {
  paymentId: string;
  decision: Decision;
}

const DATA_PATTERN = /^pay:([^:]+):(paid|skip)$/;

function parse(data: string): Parsed | undefined {
  const match = DATA_PATTERN.exec(data);
  return match ? { paymentId: match[1] as string, decision: ACTIONS[match[2] as keyof typeof ACTIONS] } : undefined;
}

async function answer(deps: CallbackDeps, query: CallbackQuery, language: Language, key: MessageKey): Promise<void> {
  await deps.client.call("answerCallbackQuery", {
    callback_query_id: query.id,
    text: t(language, key),
    show_alert: true,
  });
}

async function showStatus(deps: CallbackDeps, query: CallbackQuery, recipient: Recipient, decision: Decision): Promise<void> {
  const status = t(recipient.language, `payment.status.${decision}`);
  await deps.client.call("answerCallbackQuery", { callback_query_id: query.id, text: status });
  await deps.client.call("editMessageCaption", {
    chat_id: query.chatId,
    message_id: query.messageId,
    caption: query.caption ? `${query.caption}\n${status}` : status,
    reply_markup: { inline_keyboard: [] },
  });
}

async function findPayment(deps: CallbackDeps, paymentId: string): Promise<Payment | undefined> {
  return (await deps.storage.listPayments(deps.familyId)).find((payment) => payment.id === paymentId);
}

async function findFee(deps: CallbackDeps, payment: Payment | undefined) {
  if (!payment) return undefined;
  return (await deps.storage.listFees(deps.familyId)).find((candidate) => candidate.id === payment.feeId);
}

function recipientOf(config: Config, query: CallbackQuery, fee: Fee): Recipient | undefined {
  return config.recipients.find(
    (candidate) => candidate.telegram_chat_id === query.chatId && candidate.child_ids.includes(fee.childId),
  );
}

function languageOf(config: Config, query: CallbackQuery): Language {
  const chat = config.recipients.find((candidate) => candidate.telegram_chat_id === query.chatId);
  return chat?.language ?? config.family.default_language;
}

async function decide(deps: CallbackDeps, query: CallbackQuery, config: Config, parsed: Parsed): Promise<void> {
  const language = languageOf(config, query);
  const fee = await findFee(deps, await findPayment(deps, parsed.paymentId));
  if (!fee) return answer(deps, query, language, "payment.callback.unknown");
  const recipient = recipientOf(config, query, fee);
  if (!recipient) return answer(deps, query, language, "payment.callback.denied");
  return apply(deps, query, recipient, parsed);
}

async function apply(deps: CallbackDeps, query: CallbackQuery, recipient: Recipient, parsed: Parsed): Promise<void> {
  if (await deps.storage.setPaymentStatus(parsed.paymentId, parsed.decision, query.chatId)) {
    return showStatus(deps, query, recipient, parsed.decision);
  }
  return answer(deps, query, recipient.language, "payment.callback.already");
}

/**
 * Handles a `pay:<payment id>:paid|skip` button press. Returns false when the data is not a `pay:` callback.
 * Only a Recipient of the Child of the Fee can change the Payment. The first press sets the status, edits the
 * message and removes the buttons. A later press changes nothing.
 */
export async function handlePaymentCallback(deps: CallbackDeps, query: CallbackQuery): Promise<boolean> {
  if (!query.data.startsWith(PREFIX)) return false;
  const config = await deps.storage.loadConfig(deps.familyId);
  const parsed = parse(query.data);
  if (parsed) await decide(deps, query, config, parsed);
  else await answer(deps, query, config.family.default_language, "payment.callback.unknown");
  return true;
}
