import { t } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { handleTelegramUpdate, type HandlerDeps, type TelegramPort } from "./handle.ts";
import type { BotRecord, BotRegistry } from "./registry.ts";
import { noSpeech, type SpeechToText } from "./speech.ts";
import type { KeyValue } from "./state.ts";

const HUB_URL = "https://api2.cursor.sh/automations/webhook/hubexample";
const GRADES_URL = "https://api2.cursor.sh/automations/webhook/gradesexample";

function kv(): KeyValue {
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

function registry(rows: BotRecord[]): BotRegistry {
  return {
    async list() {
      return rows.map((row) => ({ ...row }));
    },
    async upsert(_familyId, bot) {
      const index = rows.findIndex((row) => row.slug === bot.slug);
      if (index >= 0) rows[index] = bot;
      else rows.push(bot);
    },
    async timezone() {
      return "UTC";
    },
  };
}

function bot(slug: string, url: string, patch: Partial<BotRecord> = {}): BotRecord {
  return {
    slug,
    name: slug,
    description: `${slug} handles its topic.`,
    activeHours: "always",
    webhookUrl: url,
    webhookKeyCiphertext: "v1.aa.bb",
    active: true,
    ...patch,
  };
}

function update(text: string, patch: Record<string, unknown> = {}) {
  return {
    update_id: 10,
    message: { message_id: 1, from: { id: 1000001, language_code: "en" }, chat: { id: 1000001, type: "private" }, text, ...patch },
  };
}

function deps(patch: Partial<HandlerDeps> = {}): HandlerDeps & { sent: string[]; forwarded: { url: string; key: string; payload: unknown }[]; decisions: unknown[] } {
  const sent: string[] = [];
  const forwarded: { url: string; key: string; payload: unknown }[] = [];
  const decisions: unknown[] = [];
  const telegram: TelegramPort = {
    async typing() {
      sent.push("typing");
    },
    async send(_chatId, body) {
      sent.push(body);
    },
  };
  return {
    familyId: "family-1",
    allowlist: ["1000001"],
    threshold: 0.6,
    timezone: "UTC",
    kv: kv(),
    registry: registry([bot("hub", HUB_URL), bot("grades", GRADES_URL)]),
    telegram,
    speech: noSpeech,
    now: () => new Date("2026-01-07T12:00:00Z"),
    async decide(body) {
      decisions.push(body);
      return { answers: { route: { choice: "grades", confidence: 0.91 } } };
    },
    async forward(url, key, payload) {
      forwarded.push({ url, key, payload });
    },
    async openKey() {
      return "example-key";
    },
    sent,
    forwarded,
    decisions,
    ...patch,
  };
}

describe("telegram update handling", () => {
  it("drops a sender who is not allowlisted and does not call Telegram", async () => {
    const harness = deps();
    const result = await handleTelegramUpdate(harness, update("Hello", { from: { id: 1000002 }, chat: { id: 1000002, type: "private" } }));
    expect(result).toEqual({ ok: true, status: "dropped" });
    expect(harness.sent).toEqual([]);
    expect(harness.forwarded).toEqual([]);
  });

  it("drops a group chat", async () => {
    const harness = deps();
    expect(await handleTelegramUpdate(harness, update("Hello", { chat: { id: 1000001, type: "group" } }))).toMatchObject({ status: "dropped" });
    expect(harness.sent).toEqual([]);
  });

  it("sends typing and an ack, then forwards with a mocked Jev choice", async () => {
    const harness = deps();
    const result = await handleTelegramUpdate(harness, update("What is the grade?"));
    expect(result).toEqual({ ok: true, status: "forwarded", slug: "grades" });
    expect(harness.sent.slice(0, 2)).toEqual(["typing", "One moment."]);
    const decision = harness.decisions[0] as { questions: { route: { type: string; criteria: Record<string, string> } }; state: { last_bot: null } };
    expect(decision.questions.route.type).toBe("choice");
    expect(Object.keys(decision.questions.route.criteria).sort()).toEqual(["create_new_bot", "grades", "hub"]);
    expect(harness.forwarded[0]).toMatchObject({ url: GRADES_URL, key: "example-key" });
    expect(JSON.stringify(harness.forwarded[0]?.payload)).not.toContain("api.telegram.org");
    expect(await handleTelegramUpdate(harness, update("Again"))).toMatchObject({ status: "duplicate" });
    expect(harness.forwarded).toHaveLength(1);
  });

  it("sends a low-confidence first message to the hub", async () => {
    const harness = deps({
      async decide() {
        return { answers: { route: { choice: "grades", confidence: 0.1 } } };
      },
    });
    expect(await handleTelegramUpdate(harness, update("Hmm"))).toMatchObject({ slug: "hub" });
    expect(harness.forwarded[0]?.url).toBe(HUB_URL);
  });

  it("asks for text or a photo when the message has neither", async () => {
    const harness = deps();
    const result = await handleTelegramUpdate(harness, update("", { text: undefined }));
    expect(result).toMatchObject({ status: "rejected" });
    expect(harness.sent).toContain("Send text or a photo.");
    expect(harness.forwarded).toEqual([]);
  });

  it("sends create_new_bot to the hub with that intent", async () => {
    const harness = deps({
      async decide() {
        return { answers: { route: { choice: "create_new_bot", confidence: 0.99 } } };
      },
    });
    await handleTelegramUpdate(harness, update("Make a new bot for trips."));
    expect(harness.forwarded[0]?.url).toBe(HUB_URL);
    expect(harness.forwarded[0]?.payload).toMatchObject({ route: { slug: "hub", intent: "create_new_bot" } });
  });

  it("forwards a photo without a file URL", async () => {
    const harness = deps();
    const raw = update("", {
      text: undefined,
      photo: [
        { file_id: "small", file_unique_id: "s", width: 2, height: 2, file_path: "a.jpg" },
        { file_id: "large", file_unique_id: "l", width: 20, height: 10 },
      ],
    });
    await handleTelegramUpdate(harness, raw);
    expect(harness.forwarded[0]?.payload).toMatchObject({ photo: { file_id: "large" }, text: "" });
    expect(JSON.stringify(harness.forwarded[0]?.payload)).not.toContain("file_path");
  });

  it("answers in the language of the sender and falls back to en", async () => {
    const pl = deps();
    await handleTelegramUpdate(pl, update("Hello", { from: { id: 1000001, language_code: "pl" } }));
    expect(pl.sent).toContain(t("pl", "chat.ack"));
    const other = deps();
    await handleTelegramUpdate(other, update("Hello", { from: { id: 1000001, language_code: "de" } }));
    expect(other.sent).toContain(t("en", "chat.ack"));
  });

  it("tells the person that voice is not available yet", async () => {
    const harness = deps();
    const raw = update("", { text: undefined, voice: { file_id: "voice-1", duration: 2 } });
    expect(await handleTelegramUpdate(harness, raw)).toMatchObject({ status: "rejected" });
    expect(harness.sent).toContain("Voice messages are not available yet. Send text or a photo.");
    expect(harness.forwarded).toEqual([]);
  });

  it("forwards a transcript when speech-to-text returns text", async () => {
    const speech: SpeechToText = { async transcribe() { return "from voice"; } };
    const harness = deps({ speech });
    const raw = update("", { text: undefined, voice: { file_id: "voice-1", duration: 2 } });
    await handleTelegramUpdate(harness, raw);
    expect(harness.forwarded[0]?.payload).toMatchObject({ text: "from voice" });
  });

  it("stays with the last bot when Jev fails", async () => {
    const harness = deps();
    await handleTelegramUpdate(harness, update("Grade?"));
    harness.forwarded.length = 0;
    harness.decide = async () => {
      throw new Error("jev down");
    };
    expect(await handleTelegramUpdate(harness, { ...update("And today?"), update_id: 12 })).toMatchObject({ slug: "grades" });
  });

  it("reports a missing hub and a failed forward", async () => {
    const harness = deps({ registry: registry([]) });
    expect(await handleTelegramUpdate(harness, update("Hello"))).toMatchObject({ status: "hub-missing" });
    const failing = deps({
      async forward() {
        throw new Error("no");
      },
    });
    expect(await handleTelegramUpdate(failing, update("Hello"))).toMatchObject({ status: "forward-failed" });
    expect(failing.sent).toContain("The bot did not accept the message. Try again later.");
  });

  it("releases the update id when the attempt throws", async () => {
    let fail = true;
    const harness = deps({
      telegram: {
        async typing() {
          if (fail) throw new Error("telegram down");
        },
        async send() {
          return undefined;
        },
      },
    });
    await expect(handleTelegramUpdate(harness, update("Hello"))).rejects.toThrow("telegram down");
    fail = false;
    expect(await handleTelegramUpdate(harness, update("Hello"))).toMatchObject({ status: "forwarded" });
  });

  it("ignores a payload that is not a message", async () => {
    expect(await handleTelegramUpdate(deps(), { update_id: 1 })).toEqual({ ok: true, status: "ignored" });
  });
});
