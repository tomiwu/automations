/**
 * The only code that knows how an Organizer page is read: one GET of the `sourceUrl` of the Fee and the
 * fee table in the HTML. The page amount wins over the config amount. A failed page gives the config
 * amount and one failure Notification a day for each Recipient of the Child.
 */
import type { Fee, StorageAdapter } from "@automations/librus-data";
import { localDate, t, type Runtime } from "@automations/shared";
import { createConfigFeeSource, type FeeAmount, type FeeSource } from "./fee-source.ts";
import { parseOrganizerAmount } from "./page-parse.ts";

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
  return parseOrganizerAmount(await response.text(), month);
}

/** Queues one failure Notification for each Recipient of the Child. The key has the day, so it is sent once a day. */
async function notifyFailure(deps: WebFeeSourceDeps, fee: Fee, error: unknown): Promise<void> {
  const config = await deps.storage.loadConfig(deps.familyId);
  const child = config.children.find((candidate) => candidate.id === fee.childId);
  if (!child) return;
  const day = localDate(deps.runtime.now(), config.family.timezone);
  const reason = failureReason(messageOf(error));
  deps.runtime.log("error", `fee ${fee.id}: ${reason}`);
  for (const recipient of config.recipients.filter((candidate) => candidate.child_ids.includes(fee.childId))) {
    await deps.storage.enqueueNotification({
      key: `failure:${fee.id}:${day}:${recipient.telegram_chat_id}`,
      familyId: deps.familyId,
      chatId: recipient.telegram_chat_id,
      text: t(recipient.language, "error.fetch", { child: child.name, reason }),
    });
  }
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
  return {
    async amountFor(fee, month) {
      const config = await configSource.amountFor(fee, month);
      if (!fee.sourceUrl) return config;
      try {
        const page = await pageAmount(deps.runtime, fee.sourceUrl, month);
        return page === undefined ? config : merge(fee, month, page, config);
      } catch (error) {
        await notifyFailure(deps, fee, error);
        return config;
      }
    },
  };
}
