/// <reference path="../../../shared/src/kody-runtime.d.ts" />

declare module "kody:@tomiwu/telegram/send-message" {
  export default function sendMessage(params: Record<string, unknown>): Promise<{ ok: true; messageId: number | null }>;
}

declare module "kody:@tomiwu/telegram/send-document" {
  export default function sendDocument(params: Record<string, unknown>): Promise<{ ok: true }>;
}
