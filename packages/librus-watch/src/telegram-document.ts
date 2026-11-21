import type { FetchFn } from "@automations/shared";

export type TelegramDocumentParams = Record<string, string | number | boolean | Uint8Array | object>;

export interface TelegramDocumentClient {
  sendDocument(params: TelegramDocumentParams): Promise<unknown>;
}

function formOf(params: TelegramDocumentParams): FormData {
  const form = new FormData();
  for (const [name, value] of Object.entries(params)) {
    if (value instanceof Uint8Array) {
      form.append(name, new Blob([value as BlobPart]), "document.bin");
      continue;
    }
    form.append(name, typeof value === "object" ? JSON.stringify(value) : String(value));
  }
  return form;
}

/** Posts one `sendDocument` call to the Telegram bot API. The error message never contains the token. */
export function createTelegramDocumentClient(fetchFn: FetchFn, token: string): TelegramDocumentClient {
  return {
    async sendDocument(params) {
      const response = await fetchFn(`https://api.telegram.org/bot${token}/sendDocument`, {
        method: "POST",
        body: formOf(params),
      });
      if (!response.ok) throw new Error(`Telegram sendDocument failed with status ${response.status}`);
      return response.json().catch(() => undefined);
    },
  };
}