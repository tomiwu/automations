import { createMemoryStorage } from "@automations/librus-data";
import { fakeRuntime, type Config } from "@automations/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
const CHILD1 = "00000000-0000-4000-8000-0000000000c1";
const config: Config = {
  family: { id: FAMILY_ID, name: "Example Family", timezone: "Europe/Warsaw", default_language: "en" },
  children: [{ id: CHILD1, family_id: FAMILY_ID, name: "Child One", has_librus: true, calendar_id: null }],
  accounts: [],
  activities: [],
  recipients: [{ id: "r1", family_id: FAMILY_ID, telegram_chat_id: "1000001", language: "en", child_ids: [CHILD1] }],
};

const sent: string[] = [];
const storage = createMemoryStorage({ configs: [config] });
storage.setFee({
  id: "00000000-0000-4000-8000-0000000000f1",
  familyId: FAMILY_ID,
  childId: CHILD1,
  organizer: "Example Organizer",
  recipientName: "Example Recipient",
  nip: null,
  account: "61109010140000071219812874",
  title: "Example fee",
  dueDay: 20,
  notifyDay: 10,
  reminderDay: 14,
  amounts: { "2026-01": 15050 },
  sourceUrl: null,
  accountId: null,
  enabled: true,
});

const photoCalls: string[] = [];
let paymentPhotos = false;

vi.mock("./common.ts", () => ({
  entryDeps: async () => ({ runtime: fakeRuntime({ now: new Date("2026-01-12T08:00:00Z") }), storage, familyId: FAMILY_ID, paymentPhotos }),
  telegramMessenger: { send: async (chatId: string, text: string) => void sent.push(`${chatId}|${text}`) },
  telegramClient: { call: async (method: string, params: { chat_id: string }) => void photoCalls.push(`${method}|${params.chat_id}`) },
}));

const { default: scheduled } = await import("./scheduled.ts");

describe("scheduled entry", () => {
  beforeEach(() => {
    sent.length = 0;
  });

  it("rejects input", async () => {
    await expect(scheduled({ a: 1 })).rejects.toThrow("This export takes no input.");
    await expect(scheduled(null)).rejects.toThrow("This export takes no input.");
  });

  it("runs the pass and delivers the Notification", async () => {
    expect(await scheduled()).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
  });

  it("rejects when the pass failed", async () => {
    vi.spyOn(storage, "listFees").mockRejectedValueOnce(new Error("db down"));
    await expect(scheduled({})).rejects.toThrow("payments: db down");
  });

  it("sends QR photos and no Payment text when paymentPhotos is on", async () => {
    paymentPhotos = true;
    const fresh = await storage.listPayments(FAMILY_ID);
    for (const payment of fresh) await storage.setPaymentStatus(payment.id, "skipped", "test");
    storage.setFee({ ...(await storage.listFees(FAMILY_ID))[0]!, id: "00000000-0000-4000-8000-0000000000f2" });
    expect(await scheduled()).toEqual({ ok: true });
    expect(photoCalls).toEqual(["sendPhoto|1000001"]);
    expect(sent).toEqual([]);
    paymentPhotos = false;
  });
});
