export interface TelegramUpdate {
  update_id: number;
  callback_query?: { id: string; data?: string };
  [field: string]: unknown;
}

export interface UpdateHandlers {
  payment(update: TelegramUpdate): Promise<void>;
  other(update: TelegramUpdate): Promise<void>;
}

const PAYMENT_PREFIX = "pay:";

export async function routeTelegramUpdate(update: TelegramUpdate, handlers: UpdateHandlers): Promise<void> {
  const isPayment = update.callback_query?.data?.startsWith(PAYMENT_PREFIX) === true;
  await (isPayment ? handlers.payment(update) : handlers.other(update));
}
