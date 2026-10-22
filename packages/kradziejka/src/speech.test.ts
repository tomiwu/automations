import { describe, expect, it } from "vitest";
import { noSpeech } from "./speech.ts";

describe("noSpeech", () => {
  it("returns no text", async () => {
    await expect(noSpeech.transcribe({ fileId: "f1", durationSeconds: 3, mimeType: null })).resolves.toBeNull();
  });
});
