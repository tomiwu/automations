import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DOCUMENT_SIZE_LIMIT, SEND_DOCUMENT_URL, sendDocumentBody, sendTelegramDocument } from "./telegram-document.ts";

const sample = new Uint8Array(readFileSync(new URL("./fixtures/sample.pdf", import.meta.url)));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

interface Call {
  url: string;
  init: RequestInit;
}

function fakeTelegram(status = 200, answer: unknown = { ok: true, result: { message_id: 7 } }) {
  const calls: Call[] = [];
  const fetchFn = async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer), { status });
  };
  return { calls, fetchFn };
}

describe("sendDocumentBody", () => {
  it("is the exact multipart body with the file bytes unchanged", () => {
    const body = sendDocumentBody({ chatId: "1000001", fileName: "sample.pdf", caption: "File: sample.pdf", bytes: sample, contentType: "application/pdf" }, "B");
    const head =
      '--B\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n1000001\r\n' +
      '--B\r\nContent-Disposition: form-data; name="caption"\r\n\r\nFile: sample.pdf\r\n' +
      '--B\r\nContent-Disposition: form-data; name="document"; filename="sample.pdf"\r\nContent-Type: application/pdf\r\n\r\n';
    const tail = "\r\n--B--\r\n";
    const expected = Buffer.concat([Buffer.from(head), Buffer.from(sample), Buffer.from(tail)]);
    expect(Buffer.from(body).equals(expected)).toBe(true);
    const file = body.slice(Buffer.byteLength(head), body.byteLength - Buffer.byteLength(tail));
    expect(sha(file)).toBe(sha(sample));
  });

  it("keeps a file name from breaking the multipart frame", () => {
    const text = new TextDecoder().decode(sendDocumentBody({ chatId: "1", fileName: 'a"\r\nb.pdf', caption: "", bytes: new Uint8Array() }, "B"));
    expect(text).toContain('filename="a___b.pdf"');
  });
});

describe("sendTelegramDocument", () => {
  it("posts the body to sendDocument with the token placeholder, never a token value", async () => {
    const telegram = fakeTelegram();
    await sendTelegramDocument(telegram.fetchFn, { chatId: "1000001", fileName: "sample.pdf", caption: "c", bytes: sample }, "B");
    expect(telegram.calls).toHaveLength(1);
    const [call] = telegram.calls;
    expect(call!.url).toBe(SEND_DOCUMENT_URL);
    expect(call!.url).toContain("/bot{{secret:TELEGRAM_BOT_TOKEN}}/sendDocument");
    expect(call!.init.method).toBe("POST");
    expect((call!.init.headers as Record<string, string>)["content-type"]).toBe("multipart/form-data; boundary=B");
    expect(call!.init.body).toBeInstanceOf(Uint8Array);
  });

  it("refuses a file over the size limit without a request", async () => {
    const telegram = fakeTelegram();
    const big = { byteLength: DOCUMENT_SIZE_LIMIT + 1 } as Uint8Array;
    await expect(sendTelegramDocument(telegram.fetchFn, { chatId: "1", fileName: "x", caption: "", bytes: big })).rejects.toThrow("size limit");
    expect(telegram.calls).toHaveLength(0);
  });

  it("rejects on an HTTP error or ok: false, with the status only", async () => {
    await expect(sendTelegramDocument(fakeTelegram(502, {}).fetchFn, { chatId: "1", fileName: "secret-name.pdf", caption: "", bytes: sample })).rejects.toThrow(
      "telegram sendDocument failed with status 502",
    );
    await expect(sendTelegramDocument(fakeTelegram(200, { ok: false }).fetchFn, { chatId: "1", fileName: "x", caption: "", bytes: sample })).rejects.toThrow("status 200");
  });
});
