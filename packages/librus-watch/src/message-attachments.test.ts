import { createMemoryStorage } from "@automations/librus-data";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { scopeOf, type ChildCheck } from "./engine.ts";
import { ATTACHMENT_SIZE_LIMIT, announceMessages, mimeOf } from "./message-attachments.ts";
import { CHILD1, FAMILY_ID, testConfig } from "./test-fixtures.ts";
import type { OpenedMessage } from "./types.ts";

const samplePdf = readFileSync(new URL("./fixtures/sample.pdf", import.meta.url));

function setup(pageOverride: Partial<OpenedMessage> = {}) {
  const config = testConfig();
  const storage = createMemoryStorage({ configs: [config] });
  const child = config.children[0]!;
  const downloads = new Map<string, Uint8Array>();
  const opened: string[] = [];
  const logs: string[] = [];
  const check: ChildCheck = {
    log: (line) => logs.push(line),
    familyId: FAMILY_ID,
    child,
    recipients: config.recipients.filter((r) => r.child_ids.includes(CHILD1)),
    storage,
    source: {
      async currentItems() {
        return [] as never;
      },
      async messageBody() {
        return "";
      },
      async openMessage(id) {
        opened.push(id);
        return {
          body: "Please read the file.",
          attachments: [
            {
              id: "att-001",
              name: "sample.pdf",
              size: samplePdf.byteLength,
              downloadPath: "/wiadomosci/1/7/att-001/0/sample.pdf",
            },
          ],
          unrecognizedAttachments: 0,
          ...pageOverride,
        };
      },
      async fetchAttachment(path) {
        if (!downloads.has(path)) throw new Error("missing");
        return downloads.get(path)!;
      },
      async fullTimetable() {
        return { lessons: [] };
      },
      async timetable() {
        return { lessons: [] };
      },
    },
    chargeFetch: () => true,
  };
  return { storage, check, downloads, opened, logs, scope: scopeOf("messages", child) };
}

describe("mimeOf", () => {
  it.each([
    ["sample.pdf", "application/pdf"],
    ["scan.PNG", "image/png"],
    ["photo.jpg", "image/jpeg"],
    ["photo.jpeg", "image/jpeg"],
    ["notes.txt", "application/octet-stream"],
  ])("maps %s", (name, mime) => {
    expect(mimeOf(name)).toBe(mime);
  });
});

describe("announceMessages", () => {
  it("writes AttachmentSeen and a document Outbox entry after the text", async () => {
    const { storage, check, downloads, scope } = setup();
    downloads.set("/wiadomosci/1/7/att-001/0/sample.pdf", new Uint8Array(samplePdf));
    await storage.recordItems(FAMILY_ID, scope, ["__baseline__", "m1"]);
    const result = await announceMessages(
      [{ item: { id: "m1", sender: "Teacher One", subject: "Files", sentAt: "2026-01-07" } }],
      { check, scope },
    );
    await storage.appendEvents(result.journal);
    await storage.enqueueNotifications([
      ...check.recipients.map((recipient) => ({
        key: `${scope}:m1:${recipient.telegram_chat_id}`,
        familyId: FAMILY_ID,
        chatId: recipient.telegram_chat_id,
        text: "text",
      })),
      ...result.notifications,
    ]);
    const pending = await storage.pendingNotifications(FAMILY_ID);
    expect(pending.map((e) => [e.kind, e.chatId])).toEqual([
      ["text", "1000001"],
      ["text", "1000002"],
      ["document", "1000001"],
      ["document", "1000002"],
    ]);
    const events = await storage.listEvents(FAMILY_ID, { kinds: ["attachment"] });
    expect(events[0]?.eventType).toBe("AttachmentSeen");
    expect(events[0]?.payload).toMatchObject({ fileName: "sample.pdf", messageId: "m1" });
  });

  it("queues the fallback text when the download fails", async () => {
    const { check, scope } = setup();
    const result = await announceMessages(
      [{ item: { id: "m1", sender: "Teacher One", subject: "Files", sentAt: "2026-01-07" } }],
      { check, scope },
    );
    expect(result.notifications[0]?.text).toContain("sample.pdf");
    expect(result.notifications[0]?.text).toContain("Librus");
    expect(result.journal).toEqual([]);
  });

  it("queues the fallback text when the fetch budget is exceeded", async () => {
    const { check, downloads, scope } = setup();
    downloads.set("/wiadomosci/1/7/att-001/0/sample.pdf", new Uint8Array(samplePdf));
    const result = await announceMessages(
      [{ item: { id: "m1", sender: "Teacher One", subject: "Files", sentAt: "2026-01-07" } }],
      { check, scope, chargeFetch: () => false },
    );
    expect(result.journal).toEqual([]);
    expect(result.notifications[0]?.text).toContain("sample.pdf");
  });

  it("queues the fallback text when the file is too large", async () => {
    const { check, downloads, scope } = setup();
    const huge = new Uint8Array(ATTACHMENT_SIZE_LIMIT + 1);
    downloads.set("/wiadomosci/1/7/att-001/0/sample.pdf", huge);
    const result = await announceMessages(
      [{ item: { id: "m1", sender: "Teacher One", subject: "Files", sentAt: "2026-01-07" } }],
      { check, scope, chargeFetch: () => true },
    );
    expect(result.journal).toEqual([]);
    expect(result.notifications[0]?.text).toContain("sample.pdf");
  });

  it("sends the 'open in Librus' note when the page mentions an attachment it cannot read, and logs counts only", async () => {
    const { check, logs, scope } = setup({ attachments: [], unrecognizedAttachments: 1 });
    const result = await announceMessages(
      [{ item: { id: "m1", sender: "Teacher One", subject: "Files", sentAt: "2026-01-07" } }],
      { check, scope },
    );
    expect(result.announcements).toHaveLength(1);
    expect(result.journal).toEqual([]);
    expect(result.notifications.map((n) => n.kind ?? "text")).toEqual(["text", "text"]);
    expect(result.notifications[0]?.text).toContain("Librus");
    expect(logs).toEqual(["attachments: found=0 stored=0 fallback=0 unrecognized=1"]);
  });

  it("never throws when storing fails, and keeps the message text", async () => {
    const { check, downloads, logs, scope } = setup();
    downloads.set("/wiadomosci/1/7/att-001/0/sample.pdf", new Uint8Array(samplePdf));
    check.storage = { ...check.storage, putAttachment: async () => Promise.reject(new Error("storage down")) };
    const result = await announceMessages(
      [{ item: { id: "m1", sender: "Teacher One", subject: "Files", sentAt: "2026-01-07" } }],
      { check, scope },
    );
    expect(result.announcements).toHaveLength(1);
    expect(result.journal).toEqual([]);
    expect(result.notifications[0]?.text).toContain("Librus");
    expect(logs.join("\n")).not.toContain("sample.pdf");
    expect(logs).toEqual(["attachments: found=1 stored=0 fallback=1 unrecognized=0"]);
  });

  it("opens the messages one after another", async () => {
    const { check, opened, scope } = setup();
    let active = 0;
    let most = 0;
    const open = check.source.openMessage.bind(check.source);
    check.source = {
      ...check.source,
      async openMessage(id) {
        active += 1;
        most = Math.max(most, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return open(id);
      },
    };
    await announceMessages(
      ["m1", "m2", "m3"].map((id) => ({ item: { id, sender: "Teacher One", subject: "Files", sentAt: "2026-01-07" } })),
      { check, scope },
    );
    expect(most).toBe(1);
    expect(opened).toEqual(["m1", "m2", "m3"]);
  });
});
