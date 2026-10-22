import { importCredentialKey, newCredentialKey } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { openWebhookKey, sealWebhookKey } from "./registry-crypto.ts";
import { registerBot, saveBotEdit } from "./register.ts";
import type { BotRecord, BotRegistry } from "./registry.ts";

const url = "https://api2.cursor.sh/automations/webhook/example";

function registry(): BotRegistry & { rows: BotRecord[] } {
  const rows: BotRecord[] = [];
  return {
    rows,
    async list() {
      return rows;
    },
    async upsert(_familyId, bot) {
      rows.push(bot);
    },
    async timezone() {
      return "UTC";
    },
  };
}

describe("register bot", () => {
  it("stores ciphertext and does not return the key", async () => {
    const key = await importCredentialKey(newCredentialKey());
    const store = registry();
    const result = await registerBot(
      { familyId: "family-1", registry: store, seal: (slug, value) => sealWebhookKey(key, "family-1", slug, value) },
      { slug: "hub", name: "Hub", description: "Chooses an agent.", webhookUrl: url, webhookKey: "example-webhook-key" },
    );
    expect(result).toEqual({ ok: true, slug: "hub" });
    expect(JSON.stringify(result)).not.toContain("example-webhook-key");
    expect(store.rows[0]?.webhookKeyCiphertext).not.toContain("example-webhook-key");
    await expect(openWebhookKey(key, "family-1", "hub", store.rows[0]?.webhookKeyCiphertext ?? "")).resolves.toBe("example-webhook-key");
  });

  it("keeps the stored key when an edit omits it", async () => {
    const store = registry();
    const existing: BotRecord = {
      slug: "hub",
      name: "Hub",
      description: "Old",
      activeHours: "always",
      webhookUrl: url,
      webhookKeyCiphertext: "v1.keep.keep",
      active: true,
    };
    await saveBotEdit(
      { familyId: "family-1", registry: store, seal: async () => "v1.new.new" },
      { slug: "hub", name: "Hub", description: "New text", webhookUrl: url, webhookKey: "" },
      existing,
    );
    expect(store.rows[0]?.webhookKeyCiphertext).toBe("v1.keep.keep");
    expect(store.rows[0]?.description).toBe("New text");
  });
});
