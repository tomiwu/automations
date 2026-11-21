import { createMemoryStorage } from "@automations/librus-data";
import { announceMessages } from "@tomiwu/librus-watch/message-attachments";
import { deliverPending, type Messenger } from "@tomiwu/librus-watch/deliver";
import { createTelegramDocumentClient } from "@tomiwu/librus-watch/telegram-document";
import { sha256Hex } from "@automations/librus-data";
import { readFileSync } from "node:fs";
import { parseMessageAttachments, parseMessageBody } from "@tomiwu/librus-watch/parse";
import { CHILD1, FAMILY_ID, testConfig } from "@tomiwu/librus-watch/test-fixtures";

const args = process.argv.slice(2);
const fixture = args[args.indexOf("--fixture") + 1];
const file = args[args.indexOf("--file") + 1];
if (!fixture || !file) {
  console.error("Usage: node tools/librus-attachment-fixture/src/cli.ts --fixture <html> --file <path>");
  process.exit(1);
}

const html = readFileSync(fixture, "utf8");
const bytes = new Uint8Array(readFileSync(file));
const config = testConfig();
const storage = createMemoryStorage({ configs: [config] });
const child = config.children[0]!;
const attachments = parseMessageAttachments(html);
const link = attachments[0];
if (!link) throw new Error("fixture has no attachment");
const downloadPath = link.downloadPath;
const scope = `messages:${child.id}`;

const calls: string[] = [];
const messenger: Messenger = {
  async send(chatId, text) {
    calls.push(`sendMessage chat=${chatId} text=${text.slice(0, 40)}`);
  },
  async sendDocument(chatId, fileName, document, caption) {
    const hash = await sha256Hex(document);
    calls.push(`sendDocument chat=${chatId} name=${fileName} size=${document.byteLength} sha256=${hash} caption=${caption}`);
  },
};

async function main() {
  await storage.recordItems(FAMILY_ID, scope, ["__baseline__"]);
  const check = {
    familyId: FAMILY_ID,
    child,
    recipients: config.recipients.filter((r) => r.child_ids.includes(CHILD1)),
    storage,
    source: {
      async currentItems() {
        return [] as never;
      },
      async messageBody() {
        return parseMessageBody(html);
      },
      async openMessage() {
        return { body: parseMessageBody(html), attachments };
      },
      async fetchAttachment() {
        return bytes;
      },
      async fullTimetable() {
        return { lessons: [] };
      },
      async timetable() {
        return { lessons: [] };
      },
    },
  };
  const result = await announceMessages(
    [{ item: { id: "m-fixture", sender: "Teacher One", subject: "Files", sentAt: "2026-01-07" } }],
    { check, scope },
  );
  await storage.enqueueNotifications([
    ...check.recipients.map((recipient) => ({
      key: `${scope}:m-fixture:${recipient.telegram_chat_id}`,
      familyId: FAMILY_ID,
      chatId: recipient.telegram_chat_id,
      text: parseMessageBody(html),
    })),
    ...result.notifications,
  ]);
  console.log("outbox:");
  for (const entry of await storage.pendingNotifications(FAMILY_ID)) {
    console.log(`${entry.kind} ${entry.chatId} ${entry.fileName ?? ""} ${entry.text}`);
  }
  await deliverPending({
    storage,
    familyId: FAMILY_ID,
    messenger,
    chatIds: config.recipients.map((r) => r.telegram_chat_id),
  });
  console.log("telegram:");
  for (const line of calls) console.log(line);
  if (link) {
    await createTelegramDocumentClient(async () => new Response("{}"), "X").sendDocument({
      chat_id: "1000001",
      document: bytes,
      caption: link.name,
    });
  }
}

await main();