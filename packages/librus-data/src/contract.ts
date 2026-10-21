import { describe, expect, it } from "vitest";
import { exampleConfig, FAMILY_ID, OTHER_FAMILY_ID } from "./fixtures.ts";
import type { StorageAdapter } from "./storage.ts";
import type { Config } from "@automations/shared";

/** What the contract suite needs from one adapter under test. */
export interface ContractHarness {
  storage: StorageAdapter;
  /** Makes the config of its Family readable with `loadConfig`. */
  seedConfig(config: Config): Promise<void>;
  /** Moves the time forward, so delivered entries become older. */
  advanceDays(days: number): Promise<void>;
}

const entry = (key: string, familyId = FAMILY_ID) => ({ key, familyId, chatId: "1000001", text: "Hello" });

function itemTests(create: () => Promise<ContractHarness>): void {
  it("records new Items and lists them", async () => {
    const { storage } = await create();
    expect(await storage.recordItems(FAMILY_ID, "librus", ["a", "b"])).toBe(2);
    expect(await storage.knownItemIds(FAMILY_ID, "librus")).toEqual(new Set(["a", "b"]));
    const listed = await storage.listItems(FAMILY_ID, "librus");
    expect(listed.map((item) => item.id).sort()).toEqual(["a", "b"]);
    expect(listed[0]?.firstSeen).toBeInstanceOf(Date);
  });

  it("ignores IDs that are known", async () => {
    const { storage } = await create();
    await storage.recordItems(FAMILY_ID, "librus", ["a"]);
    expect(await storage.recordItems(FAMILY_ID, "librus", ["a", "b"])).toBe(1);
    expect((await storage.listItems(FAMILY_ID, "librus")).length).toBe(2);
  });

  it("keeps Items apart per Watcher and per Family", async () => {
    const { storage } = await create();
    await storage.recordItems(FAMILY_ID, "librus", ["a"]);
    expect((await storage.knownItemIds(FAMILY_ID, "mondo")).size).toBe(0);
    expect((await storage.knownItemIds(OTHER_FAMILY_ID, "librus")).size).toBe(0);
  });
}

function outboxTests(create: () => Promise<ContractHarness>): void {
  it("enqueues once per key", async () => {
    const { storage } = await create();
    expect(await storage.enqueueNotification(entry("k1"))).toBe(true);
    expect(await storage.enqueueNotification({ ...entry("k1"), text: "Other" })).toBe(false);
    const pending = await storage.pendingNotifications(FAMILY_ID);
    expect(pending.map((item) => item.text)).toEqual(["Hello"]);
  });

  it("lists only pending entries of the Family", async () => {
    const { storage } = await create();
    await storage.enqueueNotification(entry("k1"));
    await storage.enqueueNotification(entry("k2"));
    await storage.enqueueNotification(entry("k3", OTHER_FAMILY_ID));
    await storage.markDelivered("k1");
    const pending = await storage.pendingNotifications(FAMILY_ID);
    expect(pending.map((item) => item.key)).toEqual(["k2"]);
    expect(pending[0]?.deliveredAt).toBeNull();
  });
}

function purgeTests(create: () => Promise<ContractHarness>): void {
  it("purges only entries delivered long ago", async () => {
    const { storage, advanceDays } = await create();
    await storage.enqueueNotification(entry("old"));
    await storage.enqueueNotification(entry("new"));
    await storage.enqueueNotification(entry("open"));
    await storage.markDelivered("old");
    await advanceDays(31);
    await storage.markDelivered("new");
    expect(await storage.purgeDelivered(30)).toBe(1);
    expect(await storage.purgeDelivered(30)).toBe(0);
    expect((await storage.pendingNotifications(FAMILY_ID)).map((item) => item.key)).toEqual(["open"]);
  });
}

function configTests(create: () => Promise<ContractHarness>): void {
  it("loads the config of a Family", async () => {
    const { storage, seedConfig } = await create();
    await seedConfig(exampleConfig());
    expect(await storage.loadConfig(FAMILY_ID)).toEqual(exampleConfig());
  });
}

/** The contract tests. Each StorageAdapter must pass them. */
export function runStorageContract(name: string, create: () => Promise<ContractHarness>): void {
  describe(`StorageAdapter contract: ${name}`, () => {
    itemTests(create);
    outboxTests(create);
    purgeTests(create);
    configTests(create);
  });
}
