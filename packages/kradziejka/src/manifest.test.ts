import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("package manifest", () => {
  it("declares the Telegram webhook, the reply webhook, and the register webhook", () => {
    expect(manifest.kody.webhooks).toEqual([
      { name: "telegram-update", export: "./telegram-update", responseMode: "ack", verification: { type: "url-secret" } },
      { name: "reply", export: "./reply", responseMode: "sync", inputMode: "params", verification: { type: "url-secret" } },
      { name: "register", export: "./register-bot", responseMode: "sync", inputMode: "params", verification: { type: "url-secret" } },
    ]);
    expect(manifest.kody.app.entry).toBe("./src/entry/app.ts");
    expect(manifest.kody.dependencies["@tomiwu/telegram"]).toBe("*");
  });
});
