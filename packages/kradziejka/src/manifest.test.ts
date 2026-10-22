import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const entry = readFileSync(new URL("./entry/common.ts", import.meta.url), "utf8");
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

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

  it("uses a dedicated BotFather secret for this bot", () => {
    const names = [...entry.matchAll(/secretName:\s*"([^"]+)"/g)].map((match) => match[1]);
    expect(names).toEqual(["telegramBotToken-kradziejka", "telegramBotToken-kradziejka"]);
    expect(names.every((name) => /^telegramBotToken-[a-z0-9]+$/.test(name))).toBe(true);
    expect(readme).toContain("| `telegramBotToken-kradziejka` |");
  });
});
