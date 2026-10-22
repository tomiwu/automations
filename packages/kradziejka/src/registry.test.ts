import { describe, expect, it } from "vitest";
import { createSupabaseRegistry, isRoutable, parseBotDraft, type BotRecord } from "./registry.ts";

const url = "https://api2.cursor.sh/automations/webhook/example";

function draft(patch: Record<string, unknown> = {}) {
  return {
    slug: "grades",
    name: "Grades",
    description: "Questions about grades.",
    webhookUrl: url,
    webhookKey: "example-webhook-key",
    ...patch,
  };
}

const bot = (patch: Partial<BotRecord> = {}): BotRecord => ({
  slug: "grades",
  name: "Grades",
  description: "Questions about grades.",
  activeHours: "1-5 09:00-17:00",
  webhookUrl: url,
  webhookKeyCiphertext: "v1.aa.bb",
  active: true,
  ...patch,
});

describe("registry", () => {
  it("validates a bot draft and rejects a bad url, slug, or key", () => {
    expect(parseBotDraft(draft(), true)).toMatchObject({ slug: "grades", activeHours: "always", active: true });
    expect(parseBotDraft(draft({ active: false, activeHours: "1-5 09:00-17:00" }), true).active).toBe(false);
    expect(parseBotDraft({ ...draft(), webhookKey: "" }, false).webhookKey).toBe("");
    expect(() => parseBotDraft(draft({ extra: 1 }), true)).toThrow("Unknown keys");
    expect(() => parseBotDraft(draft({ slug: "create_new_bot" }), true)).toThrow("slug");
    expect(() => parseBotDraft(draft({ webhookUrl: "https://example.test/hook" }), true)).toThrow("webhookUrl");
    expect(() => parseBotDraft(draft({ webhookKey: "short" }), true)).toThrow("webhookKey");
    expect(() => parseBotDraft(draft({ webhookKey: "" }), true)).toThrow("webhookKey is required");
    expect(() => parseBotDraft(draft({ name: "" }), true)).toThrow("name");
    expect(() => parseBotDraft(null, true)).toThrow("object");
  });

  it("routes the hub at any hour and closes other bots outside their hours", () => {
    const noon = new Date("2026-01-07T12:00:00Z");
    const night = new Date("2026-01-07T23:00:00Z");
    expect(isRoutable(bot(), noon, "UTC")).toBe(true);
    expect(isRoutable(bot(), night, "UTC")).toBe(false);
    expect(isRoutable(bot({ active: false }), noon, "UTC")).toBe(false);
    expect(isRoutable(bot({ slug: "hub", activeHours: "1-5 09:00-10:00" }), night, "UTC")).toBe(true);
    expect(isRoutable(bot({ activeHours: "nope" }), noon, "UTC")).toBe(false);
  });

  it("reads and upserts rows through PostgREST", async () => {
    const calls: { input: string; init?: RequestInit }[] = [];
    const registry = createSupabaseRegistry({
      url: "https://example.supabase.co/",
      key: "watcher-key",
      fetch: async (input, init) => {
        calls.push({ input: String(input), init });
        if (String(input).includes("kradziejka_bots?")) {
          return new Response(JSON.stringify([{ slug: "hub", name: "Hub", description: "Hub", active_hours: "always", webhook_url: url, webhook_key_ciphertext: "v1.aa.bb", active: true }]), { status: 200 });
        }
        if (String(input).includes("families?")) return new Response(JSON.stringify([{ timezone: "UTC" }]), { status: 200 });
        return new Response("", { status: 201 });
      },
    });
    expect(await registry.list("family-1")).toMatchObject([{ slug: "hub" }]);
    expect(await registry.timezone("family-1")).toBe("UTC");
    await registry.upsert("family-1", bot({ slug: "hub" }));
    expect(calls[0]?.input).toContain("family_id=eq.family-1");
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer watcher-key");
    const post = calls.find((call) => call.init?.method === "POST");
    expect(post?.input).toContain("on_conflict=family_id,slug");
    expect(String(post?.init?.body)).not.toContain("example-webhook-key");
    expect(new Headers(post?.init?.headers).get("prefer")).toContain("merge-duplicates");
  });

  it("uses UTC when the family has no time zone and surfaces HTTP errors", async () => {
    const registry = createSupabaseRegistry({
      url: "https://example.supabase.co",
      key: "k",
      fetch: async (input) => new Response(String(input).includes("families") ? "[]" : "no", { status: String(input).includes("families") ? 200 : 401 }),
    });
    expect(await registry.timezone("missing")).toBe("UTC");
    await expect(registry.list("family-1")).rejects.toThrow("401");
  });
});
