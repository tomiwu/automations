/**
 * The only code that knows how an Organizer page is read: one GET of the `sourceUrl` of the Fee and the
 * fee table in the HTML. The page amount wins over the config amount. A failed page gives the config
 * amount and one failure Notification a day for each Recipient of the Child. When a fetch fails on the
 * Kody plan limit, the source reads no more pages in the pass, and each Recipient gets at most one
 * "page source skipped: fetch cap" notice a day.
 */
import type { Fee, StorageAdapter } from "@automations/librus-data";
import { isFetchCapError, localDate, t, type MessageKey, type Runtime } from "@automations/shared";
import { createConfigFeeSource, type FeeAmount, type FeeSource } from "./fee-source.ts";
import { organizerTypeOf, parseFeePage } from "./organizer-parsers.ts";

/** Time limit of one request, in milliseconds. */
const REQUEST_TIMEOUT_MS = 25_000;
const FAILURE_DETAIL_MAX = 300;

export interface WebFeeSourceDeps {
  runtime: Runtime;
  storage: StorageAdapter;
  familyId: string;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function failureReason(message: string): string {
  const detail = message.replace(/\{\{\s*secret[^}]*\}\}/gi, "[secret]").replace(/\s+/g, " ").trim();
  return detail.length > FAILURE_DETAIL_MAX ? `${detail.slice(0, FAILURE_DETAIL_MAX - 1)}…` : detail;
}

async function pageAmount(runtime: Runtime, url: string, month: string): Promise<number | undefined> {
  const response = await runtime.fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (response.status !== 200) throw new Error(`Organizer page: request failed (HTTP ${response.status})`);
  return parseFeePage(organizerTypeOf(url), await response.text(), month);
}

/** One notice: the key prefix (the day and the chat ID follow) and the message. */
interface Notice {
  prefix: string;
  key: MessageKey;
  reason?: string;
}

/** Queues the notice for each Recipient of the Child. The key has the day, so it is sent once a day. */
async function notify(deps: WebFeeSourceDeps, fee: Fee, notice: Notice): Promise<void> {
  const config = await deps.storage.loadConfig(deps.familyId);
  const child = config.children.find((candidate) => candidate.id === fee.childId);
  if (!child) return;
  const day = localDate(deps.runtime.now(), config.family.timezone);
  for (const recipient of config.recipients.filter((candidate) => candidate.child_ids.includes(fee.childId))) {
    await deps.storage.enqueueNotification({
      key: `${notice.prefix}:${day}:${recipient.telegram_chat_id}`,
      familyId: deps.familyId,
      chatId: recipient.telegram_chat_id,
      text: t(recipient.language, notice.key, { child: child.name, reason: notice.reason ?? "" }),
    });
  }
}

/** One failure Notification a day for each Recipient of the Child of the Fee. */
async function notifyFailure(deps: WebFeeSourceDeps, fee: Fee, error: unknown): Promise<void> {
  const reason = failureReason(messageOf(error));
  deps.runtime.log("error", `fee ${fee.id}: ${reason}`);
  await notify(deps, fee, { prefix: `failure:${fee.id}`, key: "error.fetch", reason });
}

/** One "page source skipped: fetch cap" notice a day for each Recipient, for all Fees together. */
async function notifyCap(deps: WebFeeSourceDeps, fee: Fee): Promise<void> {
  deps.runtime.log("warn", `fee ${fee.id}: page source skipped: fetch cap`);
  await notify(deps, fee, { prefix: "fetch-cap", key: "payment.fetch_cap" });
}

function merge(fee: Fee, month: string, page: number, config: FeeAmount | undefined): FeeAmount {
  const found: FeeAmount = { feeId: fee.id, month, amount: page, source: "page" };
  return config && config.amount !== page ? { ...found, configAmount: config.amount } : found;
}

/**
 * Fee source for Fees with a page address. The page amount wins. When the config has a different
 * amount, it stays in `configAmount`. A Fee without a page address, a page without the month, or a
 * failed page gives the config amount.
 */
export function createWebFeeSource(deps: WebFeeSourceDeps): FeeSource {
  const configSource = createConfigFeeSource();
  let capped = false;
  const onError = async (fee: Fee, error: unknown): Promise<void> => {
    capped = isFetchCapError(error);
    await (capped ? notifyCap(deps, fee) : notifyFailure(deps, fee, error));
  };
  return {
    async amountFor(fee, month) {
      const config = await configSource.amountFor(fee, month);
      if (!fee.sourceUrl) return config;
      if (capped) return (await notifyCap(deps, fee), config);
      try {
        const page = await pageAmount(deps.runtime, fee.sourceUrl, month);
        return page === undefined ? config : merge(fee, month, page, config);
      } catch (error) {
        await onError(fee, error);
        return config;
      }
    },
  };
}
