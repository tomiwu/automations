import { describe, expect, it } from "vitest";
import { pickPhoto } from "./photo.ts";
import { assertPhotoSafe, buildForwardPayload, REPLY_INSTRUCTIONS } from "./payload.ts";

const route = { slug: "grades", intent: "message" as const, reason: "choice" };

describe("payload building", () => {
  it("sends photo fields and reply instructions, and drops file paths and file URLs", () => {
    const photo = pickPhoto([
      { file_id: "small", file_unique_id: "s", width: 10, height: 10, file_path: "photos/a.jpg" },
      { file_id: "large", file_unique_id: "l", width: 100, height: 80, file_size: 20, url: "https://api.telegram.org/file/bot9:secret/a.jpg" },
    ]);
    const payload = buildForwardPayload({
      chatId: "1000001",
      userId: "1000001",
      languageCode: "en",
      text: "See this",
      photo,
      recent: [{ from: "bot", text: "Earlier", at: "2026-01-01T00:00:00.000Z" }],
      lastBot: "hub",
      route,
    });
    expect(payload).toMatchObject({
      chat_id: "1000001",
      from: { id: "1000001", language_code: "en" },
      text: "See this",
      photo: { file_id: "large", file_unique_id: "l", width: 100, height: 80, file_size: 20 },
      last_bot: "hub",
      route: { slug: "grades", intent: "message" },
      reply_instructions: REPLY_INSTRUCTIONS,
    });
    const json = JSON.stringify(payload);
    expect(json).not.toContain("api.telegram.org");
    expect(json).not.toContain("file_path");
    expect(json).not.toContain("/file/bot");
    expect(json).not.toContain("secret");
  });

  it("omits a photo that is a Telegram file URL", () => {
    expect(pickPhoto([{ file_id: "https://api.telegram.org/file/bot1:abc/a.jpg", file_unique_id: "u", width: 1, height: 1 }])).toBeNull();
    expect(pickPhoto("nope")).toBeNull();
    expect(pickPhoto([{ width: 1 }])).toBeNull();
    expect(() => assertPhotoSafe({ fileId: "https://api.telegram.org/file/bot1:abc/a.jpg", fileUniqueId: "u", width: 1, height: 1, fileSize: null })).toThrow("file URL");
  });

  it("allows a message with no photo", () => {
    const payload = buildForwardPayload({
      chatId: "1000001",
      userId: "1000001",
      languageCode: null,
      text: "Hello",
      photo: null,
      recent: [],
      lastBot: null,
      route,
    });
    expect(payload.photo).toBeNull();
  });
});
