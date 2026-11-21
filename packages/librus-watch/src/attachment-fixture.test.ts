import { createMemoryStorage, sha256Hex } from "@automations/librus-data";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deliverPending, type Messenger } from "./deliver.ts";
import { scopeOf, type ChildCheck } from "./engine.ts";
import { announceMessages, mimeOf } from "./message-attachments.ts";
import { parseMessageAttachments, parseMessageBody, unrecognizedAttachments } from "./parse.ts";
import { sendTelegramDocument } from "./telegram-document.ts";
import { CHILD1, FAMILY_ID, testConfig } from "./test-fixtures.ts";

// Offline trigger of #263: synthetic message page + synthetic file -> watcher -> Outbox -> notifier -> fake Telegram.
// Run: npx vitest run packages/librus-watch/src/attachment-fixture.test.ts (it prints the Outbox and the Telegram calls).
const html = readFileSync(new URL("./fixtures/message-with-attachment.html", import.meta.url), "utf8");
const file = new Uint8Array(readFileSync(new URL("./fixtures/sample.pdf", import.meta.url)));
const photo = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

/** Reads chat_id, the file name and the file bytes back from the multipart body, as Telegram would. */
function readUpload(body: Uint8Array, boundary: string) {
  const text = Buffer.from(body).toString("latin1");
  const field = (name: string) => text.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`))?.[1];
  const fileName = Buffer.from(text.match(/name="document"; filename="([^"]*)"/)?.[1] ?? "", "latin1").toString("utf8");
  const start = text.indexOf("\r\n\r\n", text.indexOf('name="document"')) + 4;
  const end = text.lastIndexOf(`\r\n--${boundary}--`);
  return { chatId: field("chat_id"), fileName, bytes: body.slice(start, end) };
}

describe("attachment fixture run (offline)", () => {
  it("delivers the text, then the file as a document with the same bytes", async () => {
    const config = testConfig();
    const storage = createMemoryStorage({ configs: [config] });
    const child = config.children[0]!;
    const scope = scopeOf("messages", child);
    const attachments = parseMessageAttachments(html);
    const check: ChildCheck = {
      familyId: FAMILY_ID,
      child,
      recipients: config.recipients.filter((r) => r.child_ids.includes(CHILD1)),
      storage,
      source: {
        currentItems: async () => [] as never,
        messageBody: async () => parseMessageBody(html),
        openMessage: async () => ({ body: parseMessageBody(html), attachments, unrecognizedAttachments: unrecognizedAttachments(html, attachments) }),
        fetchAttachment: async (path) => ({ bytes: path.endsWith("/2000001") ? file : photo }),
        fullTimetable: async () => ({ lessons: [] }),
        timetable: async () => ({ lessons: [] }),
      },
    };
    const result = await announceMessages([{ item: { id: "m-fixture", sender: "Teacher One", subject: "Files", sentAt: "2026-01-07" } }], { check, scope });
    await storage.appendEvents(result.journal);
    await storage.enqueueNotifications([
      ...check.recipients.map((r) => ({ key: `${scope}:m-fixture:${r.telegram_chat_id}`, familyId: FAMILY_ID, chatId: r.telegram_chat_id, text: parseMessageBody(html) })),
      ...result.notifications,
    ]);
    const outbox = (await storage.pendingNotifications(FAMILY_ID)).map((e) => `${e.kind} chat=${e.chatId} file=${e.fileName ?? "-"} path=${e.storagePath ?? "-"}`);

    const calls: string[] = [];
    let failOnce = true;
    const fakeTelegram = async (url: string, init: RequestInit = {}) => {
      const boundary = String((init.headers as Record<string, string>)["content-type"]).split("boundary=")[1]!;
      const upload = readUpload(init.body as Uint8Array, boundary);
      if (failOnce) {
        failOnce = false;
        return new Response("{}", { status: 502 });
      }
      calls.push(`${url.split("/").pop()} chat=${upload.chatId} file=${upload.fileName} size=${upload.bytes.byteLength} sha256=${await sha256Hex(upload.bytes)}`);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    };
    const messenger: Messenger = {
      async send(chatId, text) {
        calls.push(`sendMessage chat=${chatId} chars=${text.length}`);
      },
      sendDocument: (chatId, fileName, bytes, caption) => sendTelegramDocument(fakeTelegram, { chatId, fileName, caption, bytes, contentType: mimeOf(fileName) }),
    };
    const chatIds = check.recipients.map((r) => r.telegram_chat_id);
    await expect(deliverPending({ storage, familyId: FAMILY_ID, messenger, chatIds })).rejects.toThrow("502");
    await deliverPending({ storage, familyId: FAMILY_ID, messenger, chatIds });

    console.log(["outbox:", ...outbox, "telegram:", ...calls].join("\n"));
    expect(attachments.map((link) => link.name)).toEqual(["sample.pdf", "zdjęcie 1.jpg"]);
    expect(unrecognizedAttachments(html, attachments)).toBe(0);
    const sha = await sha256Hex(file);
    const photoSha = await sha256Hex(photo);
    expect(calls.filter((c) => c.startsWith("sendDocument")).sort()).toEqual(
      chatIds
        .flatMap((chat) => [
          `sendDocument chat=${chat} file=sample.pdf size=${file.byteLength} sha256=${sha}`,
          `sendDocument chat=${chat} file=zdjęcie 1.jpg size=${photo.byteLength} sha256=${photoSha}`,
        ])
        .sort(),
    );
    expect(await storage.pendingNotifications(FAMILY_ID)).toEqual([]);
  });
});
