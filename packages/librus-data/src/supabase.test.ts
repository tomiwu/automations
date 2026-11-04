import { describe, expect, it } from "vitest";
import { runStorageContract } from "./contract.ts";
import { createFakePostgrest } from "./fake-postgrest.ts";
import { exampleConfig, FAMILY_ID } from "./fixtures.ts";
import { createSupabaseStorage, supabaseStorageFromRuntime } from "./supabase.ts";
import { fakeRuntime } from "@automations/shared";

const URL_BASE = "https://project.example.test";
const KEY = "test-key";
const START = new Date("2025-01-01T00:00:00Z");

function setup() {
  const server = createFakePostgrest(START, KEY);
  let current = START;
  const storage = createSupabaseStorage({ url: URL_BASE, key: KEY, fetch: server.fetch, now: () => current });
  const advanceDays = async (days: number): Promise<void> => {
    server.advanceDays(days);
    current = new Date(current.getTime() + days * 86_400_000);
  };
  return { server, storage, advanceDays };
}

runStorageContract("supabase (fake PostgREST)", async () => {
  const { server, storage, advanceDays } = setup();
  return { storage, advanceDays, seedConfig: async (config) => server.seedConfig(config), seedFee: async (fee) => server.seedFee(fee) };
});

describe("createSupabaseStorage", () => {
  it("sends the key and a trimmed base URL", async () => {
    const server = createFakePostgrest(START, KEY);
    const storage = createSupabaseStorage({ url: `${URL_BASE}/`, key: KEY, fetch: server.fetch });
    await storage.knownItemIds(FAMILY_ID, "librus");
    expect(server.requests[0]?.url.startsWith(`${URL_BASE}/rest/v1/items?`)).toBe(true);
    expect(server.requests[0]?.headers.get("apikey")).toBe(KEY);
  });

  it("does not send a request for an empty list of IDs", async () => {
    const { server, storage } = setup();
    expect(await storage.recordItems(FAMILY_ID, "librus", [])).toBe(0);
    expect(server.requests.length).toBe(0);
  });

  it("counts a repeated ID in one call once", async () => {
    const { storage } = setup();
    expect(await storage.recordItems(FAMILY_ID, "librus", ["a", "a"])).toBe(1);
  });

  it("encodes special characters in the filters", async () => {
    const { server, storage } = setup();
    await storage.markDelivered("a&b=c");
    expect(server.requests[0]?.url).toContain("key=eq.a%26b%3Dc");
  });

  it("throws a clear error when the key is wrong", async () => {
    const server = createFakePostgrest(START, KEY);
    const storage = createSupabaseStorage({ url: URL_BASE, key: "other", fetch: server.fetch });
    await expect(storage.knownItemIds(FAMILY_ID, "librus")).rejects.toThrow("Supabase GET items failed: 401");
  });

  it("fails to load the config of an unknown Family", async () => {
    await expect(setup().storage.loadConfig(FAMILY_ID)).rejects.toThrow("no config");
  });

  it("keeps the time of an Activity as HH:MM", async () => {
    const { server, storage } = setup();
    const config = exampleConfig();
    config.activities.push({
      id: "00000000-0000-4000-8000-0000000000d1",
      family_id: FAMILY_ID,
      child_id: config.children[0]?.id ?? "",
      account_id: config.accounts[0]?.id ?? "",
      name: "Example Class",
      weekday: 2,
      start_time: "16:30",
      end_time: "17:15",
      place: null,
      enabled: true,
    });
    server.seedConfig(config);
    expect(await storage.loadConfig(FAMILY_ID)).toEqual(config);
  });

  it("runs the keepalive read", async () => {
    const { server, storage } = setup();
    await storage.keepalive();
    expect(server.requests[0]?.method).toBe("GET");
    expect(server.requests[0]?.url).toContain("limit=1");
  });
});

describe("batched requests", () => {
  it("loads the whole config in one request", async () => {
    const { server, storage } = setup();
    server.seedConfig(exampleConfig());
    await storage.loadConfig(FAMILY_ID);
    expect(server.requests).toHaveLength(1);
  });

  it("enqueues many entries in one request and skips the known keys", async () => {
    const { server, storage } = setup();
    const entry = (key: string) => ({ key, familyId: FAMILY_ID, chatId: "1000001", text: "Hello" });
    expect(await storage.enqueueNotifications([entry("a"), entry("a"), entry("b")])).toBe(2);
    expect(await storage.enqueueNotifications([entry("a"), entry("c")])).toBe(1);
    expect(await storage.enqueueNotifications([])).toBe(0);
    expect(server.requests).toHaveLength(2);
  });

  it("marks many entries delivered in one request, also keys with special characters", async () => {
    const { server, storage } = setup();
    const entry = (key: string) => ({ key, familyId: FAMILY_ID, chatId: "1000001", text: "Hello" });
    await storage.enqueueNotifications([entry("a,b"), entry('q"x'), entry("c")]);
    server.requests.length = 0;
    await storage.markDeliveredMany(["a,b", 'q"x']);
    await storage.markDeliveredMany([]);
    expect(server.requests).toHaveLength(1);
    expect((await storage.pendingNotifications(FAMILY_ID)).map((item) => item.key)).toEqual(["c"]);
  });
});

describe("loadConfig as keepalive", () => {
  it("starts with a read of the families table, so each Watcher run is a keepalive read", async () => {
    const { server, storage } = setup();
    server.seedConfig(exampleConfig());
    await storage.loadConfig(FAMILY_ID);
    expect(server.requests[0]?.method).toBe("GET");
    expect(server.requests[0]?.url).toContain("/families?");
  });
});

describe("supabaseStorageFromRuntime", () => {
  it("reads SUPABASE_URL and SUPABASE_KEY from the secrets", async () => {
    const server = createFakePostgrest(START, KEY);
    const runtime = fakeRuntime({ secrets: { SUPABASE_URL: URL_BASE, SUPABASE_KEY: KEY }, respond: (input, init) => server.fetch(input, init) });
    const storage = await supabaseStorageFromRuntime(runtime);
    await storage.keepalive();
    expect(server.requests.length).toBe(1);
  });
});
