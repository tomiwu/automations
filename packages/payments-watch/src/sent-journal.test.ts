import { createMemoryStorage } from "@automations/librus-data";
import type { Fee, StorageAdapter } from "@automations/librus-data";
import { fakeRuntime, type Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { createConfigFeeSource } from "./fee-source.ts";
import { runPaymentsWatch } from "./run.ts";
import { recordSent, sentOfKeys } from "./sent-journal.ts";

const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
const CHILD1 = "00000000-0000-4000-8000-0000000000c1";
const FORBIDDEN = ["qr_payload", "account", "nip", "title", "recipient", "nrb", "sourceUrl"];

const config: Config = {
  family: { id: FAMILY_ID, name: "Example Family", timezone: "Europe/Warsaw", default_language: "en" },
  children: [{ id: CHILD1, family_id: FAMILY_ID, name: "Child One", has_librus: true, calendar_id: null }],
  accounts: [],
  activities: [],
  recipients: [{ id: "r1", family_id: FAMILY_ID, telegram_chat_id: "1000001", language: "en", child_ids: [CHILD1] }],
};

const fee: Fee = {
  id: "00000000-0000-4000-8000-0000000000f1",
  familyId: FAMILY_ID,
  childId: CHILD1,
  organizer: "Example Organizer",
  recipientName: "Example Recipient",
  nip: "1234563218",
  account: "61109010140000071219812874",
  title: "Example fee",
  dueDay: 20,
  notifyDay: 10,
  reminderDay: 14,
  amounts: { "2026-01": 15050 },
  sourceUrl: "https://example.org/fees",
  accountId: null,
  enabled: true,
};

function setup() {
  const storage = createMemoryStorage({ configs: [config] });
  storage.setFee(fee);
  const sent: string[] = [];
  const messenger = { send: async (chatId: string, text: string) => void sent.push(`${chatId}|${text}`) };
  const pass = (now: string, store: StorageAdapter = storage) =>
    runPaymentsWatch({
      runtime: fakeRuntime({ now: new Date(now) }),
      storage: store,
      messenger,
      familyId: FAMILY_ID,
      source: createConfigFeeSource(),
    });
  const changes = async () => (await storage.listEvents(FAMILY_ID, { kinds: ["payment"] })).filter((e) => e.eventType === "PaymentChanged");
  return { storage, sent, pass, changes };
}

describe("sentOfKeys", () => {
  it("reads the Payment keys and ignores other keys", () => {
    const sent = sentOfKeys(["payment:p1:1000001", "payment:p1:1000002", "payment:p1:1000001:reminder", "failure:f1:2026-01-10:1000001"]);
    expect([...sent]).toEqual([["p1", ["notified", "reminded"]]]);
  });
});

describe("recordSent", () => {
  it("sets notifiedAt in the Journal and the projection after the first send", async () => {
    const { storage, pass, changes } = setup();
    await pass("2026-01-10T08:00:00Z");
    const [event] = await changes();
    expect(event?.payload).toMatchObject({ status: "pending", amount: 15050, amountSource: "config", notifiedAt: "2026-01-10T08:00:00.000Z", remindedAt: null });
    expect((await storage.listPayments(FAMILY_ID))[0]?.notifiedAt).toEqual(new Date("2026-01-10T08:00:00Z"));
  });

  it("sets remindedAt after the reminder and keeps notifiedAt through later passes", async () => {
    const { storage, sent, pass, changes } = setup();
    await pass("2026-01-10T08:00:00Z");
    await pass("2026-01-14T08:00:00Z");
    await pass("2026-01-15T08:00:00Z");
    const events = await changes();
    expect(events).toHaveLength(2);
    expect(events[1]?.payload).toMatchObject({ amount: 15050, notifiedAt: "2026-01-10T08:00:00.000Z", remindedAt: "2026-01-14T08:00:00.000Z" });
    expect(sent).toHaveLength(2);
    expect((await storage.listPayments(FAMILY_ID))[0]).toMatchObject({
      notifiedAt: new Date("2026-01-10T08:00:00Z"),
      remindedAt: new Date("2026-01-14T08:00:00Z"),
    });
  });

  it("sends the first Notification and the reminder one time each in repeated passes", async () => {
    const { sent, pass } = setup();
    for (const day of ["10", "14", "14", "16"]) await pass(`2026-01-${day}T08:00:00Z`);
    expect(sent).toHaveLength(2);
  });

  it("gives a paid Payment no reminder and no further PaymentChanged", async () => {
    const { storage, sent, pass, changes } = setup();
    await pass("2026-01-10T08:00:00Z");
    const [payment] = await storage.listPayments(FAMILY_ID);
    await storage.setPaymentStatus(payment!.id, "paid", "1000001");
    await pass("2026-01-14T08:00:00Z");
    expect(sent).toHaveLength(1);
    expect(await changes()).toHaveLength(1);
  });

  it("keeps the bank data and the QR text out of the Journal", async () => {
    const { storage, pass } = setup();
    await pass("2026-01-10T08:00:00Z");
    await pass("2026-01-14T08:00:00Z");
    for (const event of await storage.listEvents(FAMILY_ID, { kinds: ["payment"] })) {
      for (const key of FORBIDDEN) expect(Object.keys(event.payload)).not.toContain(key);
      expect(JSON.stringify(event.payload)).not.toContain("61109010140000071219812874");
    }
  });

  it("does nothing when the append conflicts", async () => {
    const { storage, pass } = setup();
    await pass("2026-01-10T08:00:00Z");
    const [payment] = await storage.listPayments(FAMILY_ID);
    const conflicting: StorageAdapter = {
      ...storage,
      appendEvents: async () => {
        throw new Error("Journal event exists already");
      },
    };
    const count = await recordSent(conflicting, FAMILY_ID, [`payment:${payment!.id}:1000001:reminder`], new Date("2026-01-14T08:00:00Z"));
    expect(count).toBe(0);
    expect((await storage.listPayments(FAMILY_ID))[0]?.remindedAt).toBeNull();
  });
});
