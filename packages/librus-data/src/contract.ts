import { describe, expect, it } from "vitest";
import { exampleConfig, exampleFee, FAMILY_ID, OTHER_FAMILY_ID } from "./fixtures.ts";
import type { Fee, NewPayment, StorageAdapter } from "./storage.ts";
import type { Config } from "@automations/shared";

/** What the contract suite needs from one adapter under test. */
export interface ContractHarness {
  storage: StorageAdapter;
  /** Makes the config of its Family readable with `loadConfig`. */
  seedConfig(config: Config): Promise<void>;
  /** Makes a Fee readable with `listFees`. Fees are read-only for the Watcher. */
  seedFee(fee: Fee): Promise<void>;
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

const newPayment = (overrides: Partial<NewPayment> = {}): NewPayment => ({
  familyId: FAMILY_ID,
  feeId: exampleFee().id,
  month: "2025-01",
  amount: 15000,
  amountSource: "config",
  ...overrides,
});

const OTHER_CHILD_ID = "00000000-0000-4000-8000-0000000000c2";
const OTHER_FEE_ID = "00000000-0000-4000-8000-0000000000f2";

/** Seeds the Family, its Child and one Fee, and the same for the other Family. */
async function seedFees(harness: ContractHarness): Promise<void> {
  const own = exampleConfig();
  const other = exampleConfig(OTHER_FAMILY_ID);
  const child = other.children[0];
  await harness.seedConfig(own);
  await harness.seedConfig({ ...other, children: child ? [{ ...child, id: OTHER_CHILD_ID }] : [], accounts: [], recipients: [] });
  await harness.seedFee(exampleFee());
  await harness.seedFee(exampleFee({ id: OTHER_FEE_ID, familyId: OTHER_FAMILY_ID, childId: OTHER_CHILD_ID }));
}

function feeTests(create: () => Promise<ContractHarness>): void {
  it("lists the Fees of the Family", async () => {
    const harness = await create();
    await seedFees(harness);
    expect(await harness.storage.listFees(FAMILY_ID)).toEqual([exampleFee()]);
  });
}

function paymentTests(create: () => Promise<ContractHarness>): void {
  const start = async () => {
    const harness = await create();
    await seedFees(harness);
    return harness.storage;
  };

  it("makes a pending Payment", async () => {
    const storage = await start();
    const payment = await storage.upsertPayment(newPayment());
    expect(payment).toMatchObject({ ...newPayment(), status: "pending", notifiedAt: null, remindedAt: null });
    expect(payment.decidedAt).toBeNull();
    expect(payment.decidedBy).toBeNull();
    expect(payment.createdAt).toBeInstanceOf(Date);
    expect(await storage.listPayments(FAMILY_ID)).toEqual([payment]);
  });

  it("does not change a Payment that exists", async () => {
    const storage = await start();
    const first = await storage.upsertPayment(newPayment());
    await storage.setPaymentStatus(first.id, "paid", "1000001");
    const again = await storage.upsertPayment(newPayment({ amount: 20000, amountSource: "page" }));
    expect(again).toEqual((await storage.listPayments(FAMILY_ID))[0]);
    expect(again).toMatchObject({ id: first.id, amount: 15000, amountSource: "config", status: "paid" });
  });

  it("makes one Payment for each Fee and month", async () => {
    const storage = await start();
    await storage.upsertPayment(newPayment({ month: "2025-02" }));
    await storage.upsertPayment(newPayment());
    await storage.upsertPayment(newPayment({ familyId: OTHER_FAMILY_ID, feeId: OTHER_FEE_ID }));
    const months = (await storage.listPayments(FAMILY_ID)).map((payment) => payment.month);
    expect(months).toEqual(["2025-02", "2025-01"]);
  });

  it("sets the decision of a pending Payment", async () => {
    const storage = await start();
    const { id } = await storage.upsertPayment(newPayment());
    expect(await storage.setPaymentStatus(id, "skipped", "1000001")).toBe(true);
    const [payment] = await storage.listPayments(FAMILY_ID);
    expect(payment).toMatchObject({ status: "skipped", decidedBy: "1000001" });
    expect(payment?.decidedAt).toBeInstanceOf(Date);
  });

  it("does not change a Payment that is not pending", async () => {
    const storage = await start();
    const { id } = await storage.upsertPayment(newPayment());
    await storage.setPaymentStatus(id, "paid", "1000001");
    const [decided] = await storage.listPayments(FAMILY_ID);
    expect(await storage.setPaymentStatus(id, "skipped", "1000002")).toBe(false);
    expect(await storage.listPayments(FAMILY_ID)).toEqual([decided]);
  });

  it("returns false for an unknown Payment", async () => {
    const storage = await start();
    expect(await storage.setPaymentStatus(OTHER_FEE_ID, "paid", "1000001")).toBe(false);
  });
}

/** The contract tests. Each StorageAdapter must pass them. */
export function runStorageContract(name: string, create: () => Promise<ContractHarness>): void {
  describe(`StorageAdapter contract: ${name}`, () => {
    itemTests(create);
    outboxTests(create);
    purgeTests(create);
    configTests(create);
    feeTests(create);
    paymentTests(create);
  });
}
