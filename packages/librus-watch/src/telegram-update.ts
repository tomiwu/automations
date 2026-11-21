/** The parts of a Telegram update that the router reads. */
export interface TelegramUpdate {
  update_id: number;
  callback_query?: { id: string; data?: string };
  [field: string]: unknown;
}

export interface UpdateHandlers {
  /** Handles `pay:` callbacks. The handler lives in `payments-watch`. */
  payment(update: TelegramUpdate): Promise<void>;
  /** Handles all other updates, as before. */
  other(update: TelegramUpdate): Promise<void>;
}

const PAYMENT_PREFIX = "pay:";

/** Sends `pay:` callbacks to the payment handler. Other updates go to the existing handler. */
export async function routeTelegramUpdate(update: TelegramUpdate, handlers: UpdateHandlers): Promise<void> {
  const isPayment = update.callback_query?.data?.startsWith(PAYMENT_PREFIX) === true;
  await (isPayment ? handlers.payment(update) : handlers.other(update));
}
