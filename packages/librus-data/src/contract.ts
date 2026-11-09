import { describe, expect, it } from "vitest";
import { CHILD_ID, exampleConfig, exampleFee, FAMILY_ID, OTHER_FAMILY_ID } from "./fixtures.ts";
import type { Fee, NewItemDetail, NewJournalEvent, NewPayment, StorageAdapter } from "./storage.ts";
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

const OTHER_CHILD_ID = "00000000-0000-4000-8000-0000000000c2";

const detail = (overrides: Partial<NewItemDetail> = {}): NewItemDetail => ({
  familyId: FAMILY_ID,
  scope: "messages:child-one",
  kind: "message",
  childId: CHILD_ID,
  sourceId: "m1",
  date: "2025-01-10",
  startTime: "09:30",
  endTime: null,
  title: "Trip fee",
  text: "Please pay the fee for the trip.\nThank you.",
  sender: "Teacher One",
  subject: "Trip",
  category: null,
  sourceUpdatedAt: new Date("2025-01-09T08:00:00Z"),
  ...overrides,
});

/** The real database needs the Family of each row. */
async function detailHarness(create: () => Promise<ContractHarness>): Promise<ContractHarness> {
  const harness = await create();
  await harness.seedConfig(exampleConfig());
  await harness.seedConfig({ ...exampleConfig(OTHER_FAMILY_ID), children: [], accounts: [], recipients: [] });
  return harness;
}

function detailTests(create: () => Promise<ContractHarness>): void {
  it("stores the content of an Item and lists it", async () => {
    const { storage } = await detailHarness(create);
    expect(await storage.recordDetails([detail()])).toBe(1);
    const [stored] = await storage.listDetails(FAMILY_ID);
    expect(stored).toMatchObject(detail());
    expect(stored?.firstSeen).toBeInstanceOf(Date);
  });

  it("does not store the same content twice", async () => {
    const { storage } = await detailHarness(create);
    expect(await storage.recordDetails([detail(), detail()])).toBe(1);
    expect(await storage.recordDetails([detail(), detail({ sourceId: "m2" })])).toBe(1);
    expect(await storage.recordDetails([])).toBe(0);
    expect((await storage.listDetails(FAMILY_ID)).length).toBe(2);
  });

  it("keeps the old row when the content of an Item changes", async () => {
    const { storage } = await detailHarness(create);
    await storage.recordDetails([detail()]);
    expect(await storage.recordDetails([detail({ text: "Changed text." })])).toBe(1);
    const texts = (await storage.listDetails(FAMILY_ID)).map((row) => row.text);
    expect(texts).toHaveLength(2);
    expect(texts).toContain("Changed text.");
  });

  it("puts details on the journal as Item events", async () => {
    const { storage } = await detailHarness(create);
    const filter = { kinds: ["message" as const] };
    await storage.recordDetails([detail()]);
    await storage.recordDetails([detail()]);
    expect(await storage.listEvents(FAMILY_ID, filter)).toHaveLength(1);
    await storage.recordDetails([detail({ text: "Changed text." })]);
    const events = await storage.listEvents(FAMILY_ID, filter);
    expect(events.map((event) => [event.seq, event.eventType, event.source])).toEqual([
      [1, "ItemRecorded", "librus-watch"],
      [2, "ItemChanged", "librus-watch"],
    ]);
    expect(events[0]?.stream).toBe("item:messages:child-one:m1");
    expect(events[0]?.payload).toMatchObject({ sourceId: "m1", kind: "message", sourceUpdatedAt: "2025-01-09T08:00:00.000Z" });
  });

  it("stores many rows in batches", async () => {
    const { storage } = await detailHarness(create);
    const rows = Array.from({ length: 250 }, (_, index) => detail({ sourceId: `m${index}` }));
    expect(await storage.recordDetails(rows)).toBe(250);
    expect((await storage.listDetails(FAMILY_ID)).length).toBe(250);
  });

  it("filters by Child, day range and first-seen time", async () => {
    const { storage, advanceDays } = await detailHarness(create);
    await storage.recordDetails([
      detail({ sourceId: "a", date: "2025-01-05" }),
      detail({ sourceId: "b", date: "2025-01-10", childId: OTHER_CHILD_ID }),
      detail({ sourceId: "c", date: null }),
      detail({ sourceId: "d", date: "2025-01-20" }),
    ]);
    await advanceDays(2);
    await storage.recordDetails([detail({ sourceId: "e", date: "2025-01-12" })]);
    const ids = async (filter: Parameters<typeof storage.listDetails>[1]): Promise<string[]> =>
      (await storage.listDetails(FAMILY_ID, filter)).map((row) => row.sourceId).sort();
    expect(await ids({})).toEqual(["a", "b", "c", "d", "e"]);
    expect(await ids({ childId: OTHER_CHILD_ID })).toEqual(["b"]);
    expect(await ids({ from: "2025-01-10", to: "2025-01-20" })).toEqual(["b", "d", "e"]);
    expect(await ids({ from: "2025-01-11" })).toEqual(["d", "e"]);
    expect(await ids({ to: "2025-01-10" })).toEqual(["a", "b"]);
    expect(await ids({ since: new Date("2025-01-02T00:00:00Z") })).toEqual(["e"]);
  });

  it("keeps details apart per Family over time", async () => {
    const { storage, advanceDays } = await detailHarness(create);
    await storage.recordDetails([detail(), detail({ familyId: OTHER_FAMILY_ID })]);
    await advanceDays(400);
    expect((await storage.listDetails(FAMILY_ID)).length).toBe(1);
    expect((await storage.listDetails(OTHER_FAMILY_ID)).length).toBe(1);
  });
}

const event = (overrides: Partial<NewJournalEvent> = {}): NewJournalEvent => ({
  familyId: FAMILY_ID,
  childId: CHILD_ID,
  stream: `lesson:${CHILD_ID}:2025-01-10:1`,
  seq: 1,
  kind: "lesson",
  day: "2025-01-10",
  eventType: "LessonScheduled",
  payload: { subject: "Maths", room: "A1" },
  contentHash: "hash-1",
  source: "librus-watch",
  ...overrides,
});

function journalTests(create: () => Promise<ContractHarness>): void {
  it("appends and lists Journal events in stream and seq order", async () => {
    const { storage } = await detailHarness(create);
    expect(await storage.appendEvents([event({ seq: 2, eventType: "LessonChanged" }), event({ stream: "a", seq: 1 })])).toBe(2);
    expect(await storage.appendEvents([])).toBe(0);
    await storage.appendEvents([event()]);
    const listed = await storage.listEvents(FAMILY_ID);
    expect(listed.map((row) => [row.stream, row.seq])).toEqual([["a", 1], [event().stream, 1], [event().stream, 2]]);
    expect(listed[1]).toMatchObject({ ...event(), recordedAt: expect.any(Date) });
  });

  it("rejects a batch with a duplicate key and stores no row of it", async () => {
    const { storage } = await detailHarness(create);
    await storage.appendEvents([event()]);
    await expect(storage.appendEvents([event({ seq: 2 }), event()])).rejects.toThrow();
    await expect(storage.appendEvents([event({ seq: 3 }), event({ seq: 3 })])).rejects.toThrow();
    expect((await storage.listEvents(FAMILY_ID)).map((row) => row.seq)).toEqual([1]);
  });

  it("stores 250 events and filters them", async () => {
    const { storage } = await detailHarness(create);
    const rows = Array.from({ length: 250 }, (_, index) => event({ stream: `s${String(index).padStart(3, "0")}` }));
    expect(await storage.appendEvents(rows)).toBe(250);
    expect((await storage.listEvents(FAMILY_ID)).length).toBe(250);
    const streams = rows.slice(0, 150).map((row) => row.stream);
    expect((await storage.listEvents(FAMILY_ID, { streams })).length).toBe(150);
    expect((await storage.listHeads(FAMILY_ID, { streams })).length).toBe(150);
    expect(await storage.listEvents(FAMILY_ID, { streams: [] })).toEqual([]);
  });

  it("filters by Child, kind, day, stream and time", async () => {
    const { storage, advanceDays } = await detailHarness(create);
    await storage.appendEvents([
      event({ stream: "a", day: "2025-01-10" }),
      event({ stream: "b", day: "2025-01-12", kind: "homework" }),
      event({ stream: "c", day: null, kind: "check" }),
      event({ stream: "d", day: "2025-01-11", childId: OTHER_CHILD_ID }),
    ]);
    await advanceDays(1);
    await storage.appendEvents([event({ stream: "e", day: "2025-01-14" })]);
    const names = async (filter: Parameters<typeof storage.listEvents>[1]): Promise<string[]> =>
      (await storage.listEvents(FAMILY_ID, filter)).map((row) => row.stream);
    expect(await names({ childId: OTHER_CHILD_ID })).toEqual(["d"]);
    expect(await names({ kinds: ["homework", "check"] })).toEqual(["b", "c"]);
    expect(await names({ kinds: [] })).toEqual([]);
    expect(await names({ from: "2025-01-11", to: "2025-01-12" })).toEqual(["b", "d"]);
    expect(await names({ from: "2025-01-01" })).toEqual(["a", "b", "d", "e"]);
    expect(await names({ streams: ["a", "e"] })).toEqual(["a", "e"]);
    expect(await names({ since: new Date("2025-01-02T00:00:00Z") })).toEqual(["e"]);
  });

  it("gives the last event of each stream as the head", async () => {
    const { storage } = await detailHarness(create);
    await storage.appendEvents([event(), event({ stream: "b" })]);
    await storage.appendEvents([event({ seq: 2, eventType: "LessonChanged", payload: { room: "B2" } })]);
    const heads = (await storage.listHeads(FAMILY_ID)).sort((a, b) => a.stream.localeCompare(b.stream));
    expect(heads.map((row) => [row.stream, row.seq])).toEqual([["b", 1], [event().stream, 2]]);
    expect(heads[1]?.payload).toEqual({ room: "B2" });
    expect((await storage.listHeads(FAMILY_ID, { childId: OTHER_CHILD_ID })).length).toBe(0);
  });

  it("keeps Journal events apart per Family", async () => {
    const { storage } = await detailHarness(create);
    await storage.appendEvents([event(), event({ familyId: OTHER_FAMILY_ID })]);
    expect((await storage.listEvents(FAMILY_ID)).length).toBe(1);
    expect((await storage.listHeads(OTHER_FAMILY_ID)).length).toBe(1);
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

  it("enqueues and marks many entries at once", async () => {
    const { storage } = await create();
    expect(await storage.enqueueNotifications([entry("k1"), entry("k2"), entry("k1")])).toBe(2);
    expect(await storage.enqueueNotifications([entry("k2"), entry("k3")])).toBe(1);
    await storage.markDeliveredMany(["k1", "k3"]);
    expect((await storage.pendingNotifications(FAMILY_ID)).map((item) => item.key)).toEqual(["k2"]);
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

  it("updates the amount of a pending Payment only", async () => {
    const storage = await start();
    const { id } = await storage.upsertPayment(newPayment());
    expect(await storage.updatePendingAmount(id, 20000, "page")).toBe(true);
    expect((await storage.listPayments(FAMILY_ID))[0]).toMatchObject({ amount: 20000, amountSource: "page" });
    await storage.setPaymentStatus(id, "paid", "1000001");
    expect(await storage.updatePendingAmount(id, 30000, "config")).toBe(false);
    expect((await storage.listPayments(FAMILY_ID))[0]).toMatchObject({ amount: 20000, amountSource: "page", status: "paid" });
    expect(await storage.updatePendingAmount(OTHER_FEE_ID, 1, "config")).toBe(false);
  });

  it("sets the sent times of a pending Payment one time", async () => {
    const storage = await start();
    const { id } = await storage.upsertPayment(newPayment());
    const first = new Date("2025-01-10T10:00:00Z");
    expect(await storage.markPaymentSent(id, "notified", first)).toBe(true);
    expect(await storage.markPaymentSent(id, "notified", new Date("2025-01-11T10:00:00Z"))).toBe(false);
    expect(await storage.markPaymentSent(id, "reminded", first)).toBe(true);
    const [payment] = await storage.listPayments(FAMILY_ID);
    expect(payment).toMatchObject({ notifiedAt: first, remindedAt: first });
  });

  it("does not set the sent time of a Payment that is not pending", async () => {
    const storage = await start();
    const { id } = await storage.upsertPayment(newPayment());
    await storage.setPaymentStatus(id, "skipped", "1000001");
    expect(await storage.markPaymentSent(id, "notified", new Date())).toBe(false);
    expect((await storage.listPayments(FAMILY_ID))[0]?.notifiedAt).toBeNull();
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
    detailTests(create);
    journalTests(create);
    outboxTests(create);
    configTests(create);
    feeTests(create);
    paymentTests(create);
  });
}
