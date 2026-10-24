import { readFileSync } from "node:fs";
import { fakeRuntime } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { ACTIVENOW_CACHE_TTL_MS, cacheKey, type CacheStore } from "./activenow-cache.ts";
import { createActiveNowSource } from "./activenow-source.ts";
import { activityTargets } from "./targets.ts";
import { SECRETS, card, month, testConfig } from "./test-fixtures.ts";

const LOGIN_FORM =
  '<form action="/users/sign_in"><input type="hidden" name="authenticity_token" value="tok" /><input name="user[email]" /><input type="password" name="user[password]" /></form>';
const PICKER =
  '<meta name="csrf-token" content="csrf1"><a href="/role_selector/change_role?school_user_id=1&amp;user_equivalent_id=3"><p>Child One</p></a>';
const LESSONS = month("2026-10", card({ date: "27 października, wtorek" }));
const EMPTY = month("2026-10");
const BLOCKED = readFileSync(new URL("./fixtures/activenow-blocked.html", import.meta.url), "utf8");
const BLOCK_ERROR = "ActiveNow: HTTP 403, access temporarily blocked by ActiveNow";
const HOUR = 3_600_000;

type MemoryStore = CacheStore & { data: Map<string, string> };

function memoryStore(): MemoryStore {
  const data = new Map<string, string>();
  return { data, get: async (key) => data.get(key), set: async (key, value) => void data.set(key, value) };
}

function setup(options: { ttlMs?: number; store?: MemoryStore } = {}) {
  let lessons = LESSONS;
  let blocked = false;
  const store = options.store ?? memoryStore();
  const runtime = fakeRuntime({
    secrets: SECRETS,
    now: new Date("2026-10-20T08:00:00Z"),
    respond: (input, init) => {
      const key = `${init?.method ?? "GET"} ${new URL(input).pathname}`;
      if (blocked) return new Response(BLOCKED, { status: 403 });
      const answers: Record<string, Response> = {
        "GET /users/sign_in": new Response(LOGIN_FORM),
        "POST /users/sign_in": new Response("", { status: 302, headers: { location: "/role_selector/choose_user_role" } }),
        "GET /role_selector/choose_user_role": new Response(PICKER),
        "POST /role_selector/change_role": new Response("", { status: 302, headers: { location: "/client_panel/upcoming_classes" } }),
        "GET /client_panel/upcoming_classes": new Response("panel"),
        "GET /client_panel/all_events/events": new Response(lessons),
      };
      return answers[key] ?? new Response("missing", { status: 404 });
    },
  });
  const targets = activityTargets(testConfig()).targets;
  const source = (index = 0, ttlMs = options.ttlMs) => createActiveNowSource(runtime, targets[index]!, "UTC", { store, ttlMs });
  return {
    runtime,
    store,
    source,
    setLessons: (html: string) => void (lessons = html),
    block: () => void (blocked = true),
    advance: (ms: number) => runtime.setNow(new Date(runtime.now().getTime() + ms)),
  };
}

describe("ActiveNow cache", () => {
  it("stores the Sessions of a fresh fetch and logs it", async () => {
    const t = setup();
    const reading = await t.source().read!();
    expect(reading).toMatchObject({ cached: false, fetchedAt: "2026-10-20T08:00:00.000Z" });
    expect(reading.sessions).toHaveLength(1);
    expect(t.store.data.size).toBe(1);
    expect(t.runtime.logs.map((l) => l.message)).toEqual(["activenow: fetched"]);
  });

  it("answers from the cache inside the TTL without HTTP", async () => {
    const t = setup();
    await t.source().read!();
    const requests = t.runtime.requests.length;
    t.advance(23 * HOUR);
    const reading = await t.source().read!();
    expect(t.runtime.requests.length).toBe(requests);
    expect(reading).toMatchObject({ cached: true, fetchedAt: "2026-10-20T08:00:00.000Z" });
    expect(reading.sessions).toHaveLength(1);
    expect(t.runtime.logs.at(-1)?.message).toBe("activenow: cached (next fetch after 2026-10-21T08:00:00.000Z)");
  });

  it("fetches again after the TTL", async () => {
    const t = setup();
    await t.source().read!();
    t.advance(ACTIVENOW_CACHE_TTL_MS);
    expect((await t.source().read!()).cached).toBe(false);
  });

  it("returns the cache and the 403 error, and does not retry inside the TTL", async () => {
    const t = setup();
    await t.source().read!();
    t.advance(ACTIVENOW_CACHE_TTL_MS);
    t.block();
    const reading = await t.source().read!();
    expect(reading.cached).toBe(true);
    expect(reading.sessions).toHaveLength(1);
    expect(reading.error).toContain(BLOCK_ERROR);
    const requests = t.runtime.requests.length;
    t.advance(HOUR);
    const again = await t.source().read!();
    expect(t.runtime.requests.length).toBe(requests);
    expect(again.error).toContain(BLOCK_ERROR);
    await expect(t.source().sessions()).rejects.toThrow(BLOCK_ERROR);
  });

  it("records the attempt of a block when no cache exists", async () => {
    const t = setup();
    t.block();
    const reading = await t.source().read!();
    expect(reading).toMatchObject({ sessions: [], cached: false, fetchedAt: null });
    expect(reading.error).toContain(BLOCK_ERROR);
    const requests = t.runtime.requests.length;
    await t.source().read!();
    expect(t.runtime.requests.length).toBe(requests);
  });

  it("keeps the last good cache after an empty fetch", async () => {
    const t = setup();
    await t.source().read!();
    t.advance(ACTIVENOW_CACHE_TTL_MS);
    t.setLessons(EMPTY);
    const reading = await t.source().read!();
    expect(reading.sessions).toHaveLength(1);
    expect(reading.cached).toBe(true);
    expect(JSON.parse(t.store.data.get(cacheKey(activityTargets(testConfig()).targets[0]!.account.id))!).sessions).toHaveLength(1);
  });

  it("honours the TTL override", async () => {
    const t = setup({ ttlMs: HOUR });
    await t.source().read!();
    t.advance(30 * 60 * 1000);
    expect((await t.source().read!()).cached).toBe(true);
    t.advance(31 * 60 * 1000);
    expect((await t.source().read!()).cached).toBe(false);
  });

  it("keeps the cache of each Account apart", async () => {
    const t = setup();
    const other = { ...activityTargets(testConfig()).targets[0]!, account: { ...activityTargets(testConfig()).targets[0]!.account, id: "other-account" } };
    await t.source().read!();
    const second = createActiveNowSource(t.runtime, other, "UTC", { store: t.store });
    expect((await second.read!()).cached).toBe(false);
    expect(t.store.data.size).toBe(2);
  });

  it("ignores a damaged cache entry", async () => {
    const t = setup();
    const id = activityTargets(testConfig()).targets[0]!.account.id;
    t.store.data.set(cacheKey(id), "not json");
    expect((await t.source().read!()).cached).toBe(false);
  });
});
