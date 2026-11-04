import {
  createCredentialResolver,
  createSupabaseCredentialStore,
  createSupabaseStorage,
} from "@automations/librus-data";
import { createFakePostgrest } from "@automations/librus-data/fake-postgrest";
import { exampleConfig, FAMILY_ID } from "@automations/librus-data/fixtures";
import {
  countFetches,
  encryptCredential,
  fakeRuntime,
  importCredentialKey,
  newCredentialKey,
  type FetchCounter,
} from "@automations/shared";
import { describe, expect, it } from "vitest";
import { calendarExport, type ExportDeps } from "./exports.ts";
import { runLibrusWatch } from "./run.ts";

const SUPABASE = "https://project.example.test";
const KEY = "test-key";
const json = (body: unknown) => new Response(JSON.stringify(body));
const NAMES: Record<string, unknown> = {
  "/Users/4": { User: { FirstName: "Teacher", LastName: "One" } },
  "/Subjects/3": { Subject: { Name: "Math" } },
  "/HomeWorks/Categories/2": { Category: { Name: "Test" } },
};

const logins: string[] = [];

/** A fake Librus with the login flow, the timetable of one week and one test. */
function fakeLibrus(input: string, init?: RequestInit): Response {
  const url = new URL(input);
  if (url.host === "portal.librus.pl") return new Response('<iframe src="https://api.librus.pl/loguj/form"></iframe>');
  if (url.host === "api.librus.pl" && init?.method === "POST") logins.push(input);
  if (url.host === "api.librus.pl" && init?.method === "POST") return json({ status: "ok", goTo: "/landing" });
  if (url.host === "api.librus.pl") return new Response("form");
  if (url.pathname === "/landing") return new Response("ok");
  if (url.pathname.endsWith("/Timetables")) return json({ Timetable: {} });
  if (url.pathname.endsWith("/HomeWorks")) {
    const row = { Id: 1, Content: "Unit 3", Date: "2026-01-09", Category: { Id: 2 }, Subject: { Id: 3 }, CreatedBy: { Id: 4 } };
    return json({ HomeWorks: [row] });
  }
  const name = Object.keys(NAMES).find((suffix) => url.pathname.endsWith(suffix));
  return name ? json(NAMES[name]) : new Response("not found", { status: 404 });
}

async function setup(now = "2026-01-07T10:00:00Z") {
  const server = createFakePostgrest(new Date(now), KEY);
  logins.length = 0;
  server.seedConfig(exampleConfig());
  const credentialKey = newCredentialKey();
  const key = await importCredentialKey(credentialKey);
  for (const [name, value] of [["CHILD1_LIBRUS_LOGIN", "login-value"], ["CHILD1_LIBRUS_PASSWORD", "password-value"]] as const) {
    const ciphertext = await encryptCredential(key, FAMILY_ID, name, value);
    await server.fetch(`${SUPABASE}/rest/v1/credentials`, {
      method: "POST",
      headers: { apikey: KEY, authorization: `Bearer ${KEY}`, prefer: "return=minimal" },
      body: JSON.stringify([{ family_id: FAMILY_ID, name, ciphertext }]),
    });
  }
  server.requests.length = 0;
  const counter = countFetches((input, init) => (input.startsWith(SUPABASE) ? server.fetch(input, init) : Promise.resolve(fakeLibrus(input, init))));
  const supabase = { url: SUPABASE, key: KEY, fetch: counter.fetch };
  const resolve = createCredentialResolver(createSupabaseCredentialStore(supabase), key, FAMILY_ID);
  const base = fakeRuntime({ now: new Date(now) });
  const runtime = { ...base, fetch: counter.fetch, secret: resolve };
  const storage = createSupabaseStorage({ ...supabase, now: () => new Date(now) });
  return { runtime, storage, counter, server };
}

function memoryStore() {
  const data = new Map<string, string>();
  return { get: async (key: string) => data.get(key), set: async (key: string, value: string) => void data.set(key, value) };
}

const deps = async (counter: FetchCounter, parts: Awaited<ReturnType<typeof setup>>, nameStore = memoryStore()): Promise<ExportDeps> => ({
  runtime: parts.runtime,
  storage: parts.storage,
  familyId: FAMILY_ID,
  counter,
  nameStore,
});

describe("fetch budget", () => {
  it("the combined export makes one Librus login and a known number of fetches", async () => {
    const parts = await setup();
    const result = await calendarExport(await deps(parts.counter, parts), {});
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({ category: "Test", subject: "Math", teacher: "Teacher One" });
    // Login: portal, form, POST, landing = 4. Timetable: 3 weeks. Homework: 1 list + 3 names. Supabase: 2.
    expect(logins).toHaveLength(1);
    expect(result.fetches).toEqual({
      total: 13,
      hosts: { "project.example.test": 2, "api.librus.pl": 3, "portal.librus.pl": 1, "school.example.org": 7 },
    });
  });

  it("loads the config and the credentials in at most 2 Supabase fetches", async () => {
    const parts = await setup();
    await calendarExport(await deps(parts.counter, parts), {});
    expect(parts.counter.count().hosts["project.example.test"]).toBeLessThanOrEqual(2);
  });

  it("a second run with the same IDs makes 0 name-lookup fetches", async () => {
    const store = memoryStore();
    const first = await setup();
    await calendarExport(await deps(first.counter, first, store), {});
    const second = await setup();
    const result = await calendarExport(await deps(second.counter, second, store), {});
    expect(result.fetches?.total).toBe(10);
    expect(result.entries[0]?.teacher).toBe("Teacher One");
  });

  it("logs the fetch total and the host split at the end of an export and a run", async () => {
    const parts = await setup();
    await calendarExport(await deps(parts.counter, parts), {});
    const base = parts.runtime as unknown as ReturnType<typeof fakeRuntime>;
    expect(base.logs.map((l) => l.message)).toContain(
      "fetches total=13 api.librus.pl=3 portal.librus.pl=1 project.example.test=2 school.example.org=7",
    );
    const run = await setup("2026-01-07T10:00:00Z");
    const messenger = { send: async () => {} };
    const failures = await runLibrusWatch({ runtime: run.runtime, storage: run.storage, familyId: FAMILY_ID, messenger, counter: run.counter, nameStore: memoryStore() });
    expect(failures.every((f) => f.includes("HTTP 404"))).toBe(true);
    const lines = (run.runtime as unknown as ReturnType<typeof fakeRuntime>).logs.map((l) => l.message);
    expect(lines.at(-1)).toMatch(/^fetches total=\d+ /);
  });
});
