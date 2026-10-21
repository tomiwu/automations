import { createMemoryStorage } from "@automations/librus-data";
import { describe, expect, it } from "vitest";
import { deliverPending, redactSecretPlaceholders, splitForTelegram, withTimeout, type Messenger } from "./deliver.ts";
import { FAMILY_ID } from "./test-fixtures.ts";

const entry = (key: string, chatId: string, text = "text") => ({ key, familyId: FAMILY_ID, chatId, text });

function messenger(fail: string[] = []) {
  const sent: string[] = [];
  const m: Messenger = {
    async send(chatId, text) {
      if (fail.includes(chatId)) throw new Error("send failed");
      sent.push(`${chatId}|${text}`);
    },
  };
  return { m, sent };
}

describe("deliverPending", () => {
  it("delivers in order and marks entries delivered", async () => {
    const storage = createMemoryStorage();
    await storage.enqueueNotification(entry("a", "1000001", "one"));
    await storage.enqueueNotification(entry("b", "1000002", "two"));
    const { m, sent } = messenger();
    await deliverPending({ storage, familyId: FAMILY_ID, messenger: m, chatIds: ["1000001", "1000002"] });
    expect(sent).toEqual(["1000001|one", "1000002|two"]);
    expect(await storage.pendingNotifications(FAMILY_ID)).toEqual([]);
  });

  it("holds back only the chat that failed, then rejects", async () => {
    const storage = createMemoryStorage();
    await storage.enqueueNotification(entry("a", "1000001"));
    await storage.enqueueNotification(entry("b", "1000001"));
    await storage.enqueueNotification(entry("c", "1000002"));
    const { m, sent } = messenger(["1000001"]);
    const lines: string[] = [];
    await expect(
      deliverPending({ storage, familyId: FAMILY_ID, messenger: m, chatIds: ["1000001", "1000002"], log: (l) => lines.push(l) }),
    ).rejects.toThrow("send failed");
    expect(sent).toEqual(["1000002|text"]);
    expect((await storage.pendingNotifications(FAMILY_ID)).map((e) => e.key)).toEqual(["a", "b"]);
    expect(lines).toEqual(["deliver: queued=3 sent=1 failed=1"]);
  });

  it("ignores entries of chats that are not Recipients", async () => {
    const storage = createMemoryStorage();
    await storage.enqueueNotification(entry("a", "9999999"));
    const { m, sent } = messenger();
    await deliverPending({ storage, familyId: FAMILY_ID, messenger: m, chatIds: ["1000001"] });
    expect(sent).toEqual([]);
  });

  it("leaves entries queued when the time budget is used", async () => {
    const storage = createMemoryStorage();
    await storage.enqueueNotification(entry("a", "1000001"));
    const { m, sent } = messenger();
    let time = 0;
    await deliverPending({ storage, familyId: FAMILY_ID, messenger: m, chatIds: ["1000001"], budgetMs: 10, clock: () => (time += 100) });
    expect(sent).toEqual([]);
  });

  it("redacts secret placeholders", async () => {
    const storage = createMemoryStorage();
    await storage.enqueueNotification(entry("a", "1000001", "x {{secret:NAME}} y"));
    const { m, sent } = messenger();
    await deliverPending({ storage, familyId: FAMILY_ID, messenger: m, chatIds: ["1000001"] });
    expect(sent).toEqual(["1000001|x [secret] y"]);
  });
});

describe("helpers", () => {
  it("withTimeout rejects a slow promise", async () => {
    await expect(withTimeout(new Promise(() => {}), 5, "job")).rejects.toThrow("job timed out after 0s");
    await expect(withTimeout(Promise.resolve(1), 50, "job")).resolves.toBe(1);
  });

  it("splitForTelegram keeps short text and splits long text", () => {
    expect(splitForTelegram("a\nb")).toEqual(["a\nb"]);
    expect(splitForTelegram("aaa\nbbb\nccc", 7)).toEqual(["aaa\nbbb", "ccc"]);
    expect(splitForTelegram("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
  });

  it("redactSecretPlaceholders leaves other text", () => {
    expect(redactSecretPlaceholders("a {{ secret/x:N }} b")).toBe("a [secret] b");
    expect(redactSecretPlaceholders("plain")).toBe("plain");
  });
});
