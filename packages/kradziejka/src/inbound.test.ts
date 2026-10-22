import { describe, expect, it } from "vitest";
import { parseInbound } from "./inbound.ts";

const message = {
  message_id: 1,
  from: { id: 1000001, language_code: "en" },
  chat: { id: 1000001, type: "private" },
  text: "Hello",
};

describe("inbound updates", () => {
  it("reads a bare update and a webhook envelope", () => {
    const update = { update_id: 4, message };
    expect(parseInbound(update)?.text).toBe("Hello");
    expect(parseInbound({ webhook: { name: "telegram-update" }, request: { json: update } })?.senderId).toBe("1000001");
    expect(parseInbound({ request: { json: null } })).toBeNull();
    expect(parseInbound({ update_id: 1 })).toBeNull();
    expect(parseInbound(null)).toBeNull();
  });

  it("uses the caption, the largest safe photo, and a voice note", () => {
    const photo = parseInbound({
      update_id: 5,
      message: {
        ...message,
        text: undefined,
        caption: "Look",
        photo: [
          { file_id: "small", file_unique_id: "s", width: 1, height: 1 },
          { file_id: "large", file_unique_id: "l", width: 40, height: 20, file_size: 9 },
        ],
      },
    });
    expect(photo?.text).toBe("Look");
    expect(photo?.photo).toMatchObject({ fileId: "large", fileSize: 9 });
    const voice = parseInbound({
      update_id: 6,
      message: { ...message, text: undefined, voice: { file_id: "v1", duration: 3, mime_type: "audio/ogg" } },
    });
    expect(voice?.voice).toEqual({ fileId: "v1", durationSeconds: 3, mimeType: "audio/ogg" });
    expect(parseInbound({ update_id: 7, message: { ...message, voice: { file_id: "https://api.telegram.org/file/bot1:abc/a.ogg", duration: 1 } } })?.voice).toBeNull();
  });

  it("accepts string ids", () => {
    const parsed = parseInbound({
      update_id: 8,
      message: { ...message, from: { id: "1000001", language_code: "en" }, chat: { id: "1000001", type: "private" } },
    });
    expect(parsed?.senderId).toBe("1000001");
    expect(parseInbound({ update_id: 9, message: { ...message, chat: { id: 0, type: "private" } } })).toBeNull();
  });

  it("rejects a bad identity", () => {
    expect(parseInbound({ update_id: -1, message })).toBeNull();
    expect(parseInbound({ update_id: 1, message: { ...message, from: { id: "nope" } } })).toBeNull();
    expect(parseInbound({ update_id: 1, message: { chat: { id: "1000001", type: "private" }, text: "Hi" } })).toBeNull();
  });
});
