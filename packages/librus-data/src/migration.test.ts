import { describe, expect, it } from "vitest";
import { FAMILY_ID } from "./fixtures.ts";
import { createMemoryStorage } from "./memory.ts";
import {
  CountCheckError,
  exportKodyData,
  importKodyData,
  parseMigrationExport,
  type KodyStorage,
  type MigrationExport,
} from "./migration.ts";

const AT = "2025-01-01T10:00:00.000Z";

function kodyStorage(values: Record<string, unknown>): KodyStorage {
  return { get: async (key) => values[key] };
}

const kodyValues = {
  "items:grades": JSON.stringify([
    { id: "g1", firstSeen: AT },
    { id: "g2", firstSeen: AT },
  ]),
  "items:messages": [{ id: "m1", firstSeen: AT }],
  outbox: JSON.stringify([
    { key: "grades:g1:1000001", chatId: "1000001", text: "New grade", queuedAt: AT, deliveredAt: AT },
    { key: "grades:g2:1000001", chatId: "1000001", text: "New grade", queuedAt: AT },
    { key: "old", text: "No chat", queuedAt: AT },
  ]),
};

describe("exportKodyData", () => {
  it("reads Items per Watcher and Outbox entries with a chat", async () => {
    const data = await exportKodyData(kodyStorage(kodyValues), ["grades", "messages", "lessons"]);
    expect(Object.keys(data.items)).toEqual(["grades", "messages", "lessons"]);
    expect(data.items.grades).toHaveLength(2);
    expect(data.items.lessons).toEqual([]);
    expect(data.outbox.map((e) => [e.key, e.deliveredAt])).toEqual([
      ["grades:g1:1000001", AT],
      ["grades:g2:1000001", null],
    ]);
  });

  it("handles empty storage", async () => {
    expect(await exportKodyData(kodyStorage({}), ["grades"])).toEqual({ version: 1, items: { grades: [] }, outbox: [] });
  });

  it.each([
    ["bad json", { "items:grades": "{" }],
    ["not a list", { "items:grades": "{}" }],
    ["bad item", { "items:grades": [{ id: "g1" }] }],
    ["bad entry", { outbox: [{ key: "k", chatId: "1", text: "t" }] }],
  ])("rejects corrupt data: %s", async (_name, values) => {
    await expect(exportKodyData(kodyStorage(values), ["grades"])).rejects.toThrow("Corrupt data");
  });
});

describe("importKodyData", () => {
  it("imports and returns the counts", async () => {
    const storage = createMemoryStorage();
    const data = await exportKodyData(kodyStorage(kodyValues), ["grades", "messages"]);
    const report = await importKodyData(storage, FAMILY_ID, data);
    expect(report).toEqual({ items: { grades: 2, messages: 1 }, pending: 1 });
    expect((await storage.pendingNotifications(FAMILY_ID)).map((e) => e.key)).toEqual(["grades:g2:1000001"]);
  });

  it("is safe to run twice", async () => {
    const storage = createMemoryStorage();
    const data = await exportKodyData(kodyStorage(kodyValues), ["grades"]);
    await importKodyData(storage, FAMILY_ID, data);
    await expect(importKodyData(storage, FAMILY_ID, data)).resolves.toMatchObject({ pending: 1 });
  });

  it("fails when the target has extra pending entries", async () => {
    const storage = createMemoryStorage();
    await storage.enqueueNotification({ key: "extra", familyId: FAMILY_ID, chatId: "1000001", text: "x" });
    const data = await exportKodyData(kodyStorage(kodyValues), ["grades"]);
    const error = await importKodyData(storage, FAMILY_ID, data).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CountCheckError);
    expect((error as CountCheckError).differences).toEqual([{ scope: "pending outbox", expected: 1, actual: 2 }]);
  });

  it("fails when the target has extra Items", async () => {
    const storage = createMemoryStorage();
    await storage.recordItems(FAMILY_ID, "grades", ["other"]);
    const data = await exportKodyData(kodyStorage(kodyValues), ["grades"]);
    await expect(importKodyData(storage, FAMILY_ID, data)).rejects.toThrow("items grades: expected 2, found 3");
  });
});

describe("parseMigrationExport", () => {
  const valid: MigrationExport = { version: 1, items: { grades: [{ id: "g1", firstSeen: AT }] }, outbox: [] };

  it("parses a valid file", () => {
    expect(parseMigrationExport(JSON.stringify(valid))).toEqual(valid);
  });

  it.each([
    ["null", "null"],
    ["wrong version", JSON.stringify({ ...valid, version: 2 })],
    ["items not an object", JSON.stringify({ ...valid, items: null })],
    ["items list wrong", JSON.stringify({ ...valid, items: { grades: 1 } })],
    ["outbox wrong", JSON.stringify({ ...valid, outbox: {} })],
  ])("rejects: %s", (_name, text) => {
    expect(() => parseMigrationExport(text)).toThrow("wrong format");
  });

  it("rejects text that is not JSON", () => {
    expect(() => parseMigrationExport("{")).toThrow("Corrupt data");
  });
});
