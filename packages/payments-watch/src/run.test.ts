import { createMemoryStorage } from "@automations/librus-data";
import type { Fee } from "@automations/librus-data";
import { fakeRuntime, type Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { createConfigFeeSource } from "./fee-source.ts";
import { createWebFeeSource } from "./page-source.ts";
import { runPaymentsWatch } from "./run.ts";

const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
const CHILD1 = "00000000-0000-4000-8000-0000000000c1";

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
};

function setup(sendError?: Error) {
  const storage = createMemoryStorage({ configs: [config] });
  storage.setFee(fee);
  const sent: string[] = [];
  const messenger = {
    async send(chatId: string, text: string) {
      if (sendError) throw sendError;
      sent.push(`${chatId}|${text}`);
    },
  };
  const runtime = fakeRuntime({ now: new Date("2026-01-12T08:00:00Z") });
  const deps = { runtime, storage, messenger, familyId: FAMILY_ID, source: createConfigFeeSource() };
  return { deps, sent, storage };
}

describe("runPaymentsWatch", () => {
  it("makes the Payment and delivers the Notification once", async () => {
    const { deps, sent, storage } = setup();
    expect(await runPaymentsWatch(deps)).toEqual([]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("1000001|");
    expect(await storage.listPayments(FAMILY_ID)).toHaveLength(1);
    expect(await runPaymentsWatch(deps)).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it("returns a failure text when the delivery fails", async () => {
    const { deps } = setup(new Error("send down"));
    expect(await runPaymentsWatch(deps)).toEqual(["deliver: send down"]);
  });

  it("returns a failure text when the engine fails", async () => {
    const { deps } = setup();
    const storage = { ...deps.storage, listFees: async () => Promise.reject(new Error("db down")) };
    expect(await runPaymentsWatch({ ...deps, storage })).toEqual(["payments: db down"]);
  });
});

describe("runPaymentsWatch on the Kody fetch cap", () => {
  const capError = () => Object.assign(new Error("Plan limit reached"), { name: "EntitlementLimitError" });

  function capped() {
    const storage = createMemoryStorage({ configs: [config] });
    storage.setFee({ ...fee, sourceUrl: "https://organizer.example.com/fees" });
    storage.setFee({ ...fee, id: "00000000-0000-4000-8000-0000000000f2", sourceUrl: "https://organizer.example.com/other", amounts: { "2026-01": 9000 } });
    const sent: string[] = [];
    const messenger = { send: async (chatId: string, text: string) => void sent.push(`${chatId}|${text}`) };
    const runtime = fakeRuntime({
      now: new Date("2026-01-12T08:00:00Z"),
      respond: () => {
        throw capError();
      },
    });
    const source = createWebFeeSource({ runtime, storage, familyId: FAMILY_ID });
    return { deps: { runtime, storage, messenger, familyId: FAMILY_ID, source }, storage, sent, runtime };
  }

  it("makes the Payments from the config amounts, does not throw and sends one cap notice a day", async () => {
    const { deps, storage, sent, runtime } = capped();
    expect(await runPaymentsWatch(deps)).toEqual([]);
    const payments = await storage.listPayments(FAMILY_ID);
    expect(payments.map((p) => [p.amount, p.amountSource]).sort()).toEqual([[15050, "config"], [9000, "config"]]);
    expect(sent.filter((line) => line.includes("Page source skipped: fetch cap"))).toHaveLength(1);
    expect(runtime.requests).toHaveLength(1);
    const events = await storage.listEvents(FAMILY_ID);
    expect(events.filter((event) => event.eventType === "CheckCompleted")).toHaveLength(1);
    expect(await runPaymentsWatch(deps)).toEqual([]);
    expect(sent.filter((line) => line.includes("Page source skipped: fetch cap"))).toHaveLength(1);
  });

  it("logs a fetch-cap failure of the pass as a warning and does not return it", async () => {
    const { deps } = setup();
    deps.storage.listFees = async () => {
      throw capError();
    };
    expect(await runPaymentsWatch(deps)).toEqual([]);
    expect(deps.runtime.logs).toContainEqual({ level: "warn", message: "fetch cap: payments: Plan limit reached" });
  });

  it("still returns other failures", async () => {
    const { deps } = setup();
    deps.storage.listFees = async () => {
      throw new Error("HTTP 500");
    };
    expect(await runPaymentsWatch(deps)).toEqual(["payments: HTTP 500"]);
  });
});
