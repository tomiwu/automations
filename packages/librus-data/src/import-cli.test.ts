import { fakeRuntime } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { createFakePostgrest } from "./fake-postgrest.ts";
import { FAMILY_ID } from "./fixtures.ts";
import { runImport } from "./import-cli.ts";

const KEY = "test-key";
const AT = "2025-01-01T10:00:00.000Z";
const file = JSON.stringify({
  version: 1,
  items: { grades: [{ id: "g1", firstSeen: AT }] },
  outbox: [{ key: "grades:g1:1000001", chatId: "1000001", text: "New grade", queuedAt: AT, deliveredAt: null }],
});

function setup(secrets: Record<string, string>) {
  const server = createFakePostgrest(new Date(AT), KEY);
  const runtime = fakeRuntime({ secrets, respond: (input, init) => server.fetch(input, init) });
  const lines: string[] = [];
  return { runtime, lines, deps: { runtime, readFile: async () => file, print: (l: string) => void lines.push(l) } };
}

const secrets = { SUPABASE_URL: "https://project.example.test", SUPABASE_KEY: KEY, FAMILY_ID };

describe("runImport", () => {
  it("imports the file and prints the counts", async () => {
    const { deps, lines } = setup(secrets);
    await runImport(["export.json"], deps);
    expect(lines).toEqual(["items grades: 1", "pending outbox: 1", "Count check passed."]);
  });

  it("needs a file argument", async () => {
    const { deps } = setup(secrets);
    await expect(runImport([], deps)).rejects.toThrow("Usage");
  });

  it("needs the family ID", async () => {
    const { deps } = setup({ SUPABASE_URL: secrets.SUPABASE_URL, SUPABASE_KEY: KEY });
    await expect(runImport(["export.json"], deps)).rejects.toThrow("FAMILY_ID");
  });
});
