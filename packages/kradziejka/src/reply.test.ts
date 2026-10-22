import { describe, expect, it } from "vitest";
import { handleReply } from "./reply.ts";
import type { KeyValue } from "./state.ts";

function kv(): KeyValue & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
  };
}

describe("reply webhook", () => {
  it("sends the text to an allowlisted chat and stores it", async () => {
    const store = kv();
    const sent: string[] = [];
    const result = await handleReply(
      {
        allowlist: ["1000001"],
        kv: store,
        telegram: { async typing() { return undefined; }, async send(_chat, body) { sent.push(body); } },
        now: () => new Date("2026-01-07T12:00:00Z"),
      },
      { chat_id: "1000001", text: "Page 4." },
    );
    expect(result).toEqual({ ok: true, chat_id: "1000001" });
    expect(sent).toEqual(["Page 4."]);
    expect(store.data.get("chat:1000001")).toContain("Page 4.");
  });

  it("splits a long reply and rejects other chats and unknown keys", async () => {
    const sent: string[] = [];
    await handleReply(
      {
        allowlist: ["1000001"],
        kv: kv(),
        telegram: { async typing() { return undefined; }, async send(_chat, body) { sent.push(body); } },
        now: () => new Date(0),
      },
      { chat_id: "1000001", text: "a".repeat(3501) },
    );
    expect(sent.map((part) => part.length)).toEqual([3500, 1]);
    await expect(handleReply({ allowlist: ["1000001"], kv: kv(), telegram: { async typing() { return undefined; }, async send() { return undefined; } }, now: () => new Date(0) }, { chat_id: "1000002", text: "Hi" })).rejects.toThrow("allowlisted");
    await expect(handleReply({ allowlist: ["1000001"], kv: kv(), telegram: { async typing() { return undefined; }, async send() { return undefined; } }, now: () => new Date(0) }, { chat_id: "1000001", text: "Hi", extra: 1 })).rejects.toThrow("Unknown keys");
    await expect(handleReply({ allowlist: ["1000001"], kv: kv(), telegram: { async typing() { return undefined; }, async send() { return undefined; } }, now: () => new Date(0) }, { chat_id: "abc", text: "Hi" })).rejects.toThrow("chat_id");
  });
});
