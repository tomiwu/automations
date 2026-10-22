import { describe, expect, it } from "vitest";
import { appendTurn, loadChat, parseChat, rememberRoute, saveChat, type KeyValue } from "./state.ts";
import { claimUpdate, releaseUpdate } from "./updates.ts";

function memoryKv(): KeyValue {
  const data = new Map<string, string>();
  return {
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
  };
}

describe("chat state and update ids", () => {
  it("stores the last bot and the last messages", async () => {
    const kv = memoryKv();
    expect(await loadChat(kv, "1000001")).toEqual({ lastBot: null, messages: [] });
    const next = rememberRoute({ lastBot: null, messages: [] }, "Hello", "grades", "2026-01-01T00:00:00.000Z");
    await saveChat(kv, "1000001", next);
    expect(await loadChat(kv, "1000001")).toEqual(next);
    expect(parseChat("{")).toEqual({ lastBot: null, messages: [] });
    expect(parseChat({ lastBot: null, messages: [] })).toEqual({ lastBot: null, messages: [] });
    expect(parseChat({ lastBot: "hub" })).toEqual({ lastBot: null, messages: [] });
    expect(parseChat({ lastBot: 1, messages: [] })).toEqual({ lastBot: null, messages: [] });
    expect(parseChat({ lastBot: "hub", messages: [{ from: "bot", text: 1, at: "t" }] }).messages).toEqual([]);
    expect(parseChat({ lastBot: "hub", messages: [{ from: "nope", text: "x", at: "t" }, { from: "bot", text: "ok", at: "t" }] }).messages).toEqual([
      { from: "bot", text: "ok", at: "t" },
    ]);
  });

  it("keeps eight turns and clips a long turn", () => {
    let state = { lastBot: null as string | null, messages: [] as { from: "person" | "bot"; text: string; at: string }[] };
    for (let index = 0; index < 9; index += 1) state = appendTurn(state, "person", `m${index}`, "t");
    expect(state.messages).toHaveLength(8);
    expect(state.messages[0]?.text).toBe("m1");
    expect(appendTurn(state, "person", "x".repeat(500), "t").messages.at(-1)?.text).toHaveLength(400);
  });

  it("claims an update id once and can release it", async () => {
    const kv = memoryKv();
    expect(await claimUpdate(kv, 7)).toBe(true);
    expect(await claimUpdate(kv, 7)).toBe(false);
    expect(await claimUpdate(kv, -1)).toBe(false);
    expect(await claimUpdate(kv, 1.5)).toBe(false);
    await releaseUpdate(kv, 7);
    expect(await claimUpdate(kv, 7)).toBe(true);
    await kv.set("seen-update-ids", "not-json");
    expect(await claimUpdate(kv, 8)).toBe(true);
  });

  it("rejects a chat id that is not decimal", async () => {
    await expect(loadChat(memoryKv(), "abc")).rejects.toThrow("chat_id");
  });
});
