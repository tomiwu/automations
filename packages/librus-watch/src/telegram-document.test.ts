import { describe, expect, it } from "vitest";
import { createTelegramDocumentClient } from "./telegram-document.ts";

const sample = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

describe("createTelegramDocumentClient", () => {
  it("posts sendDocument as multipart form data with the right bytes", async () => {
    const requests: { url: string; body: FormData }[] = [];
    const client = createTelegramDocumentClient(async (url, init) => {
      requests.push({ url, body: init?.body as FormData });
      return new Response('{"ok":true}');
    }, "TOKEN_PLACEHOLDER");
    await client.sendDocument({
      chat_id: "1000001",
      document: sample,
      caption: "sample.pdf",
    });
    expect(requests[0]?.url).toBe("https://api.telegram.org/botTOKEN_PLACEHOLDER/sendDocument");
    expect(requests[0]?.body.get("chat_id")).toBe("1000001");
    expect(requests[0]?.body.get("caption")).toBe("sample.pdf");
    const blob = requests[0]?.body.get("document");
    expect(blob).toBeInstanceOf(Blob);
    expect(new Uint8Array(await (blob as Blob).arrayBuffer())).toEqual(sample);
  });

  it("throws without the token in the message when Telegram refuses", async () => {
    const client = createTelegramDocumentClient(async () => new Response("{}", { status: 502 }), "TOKEN_PLACEHOLDER");
    await expect(client.sendDocument({ chat_id: "1000001", document: sample })).rejects.toThrow(
      "Telegram sendDocument failed with status 502",
    );
  });
});