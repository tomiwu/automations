import { readFileSync } from "node:fs";
import { createMemoryStorage } from "@automations/librus-data";
import type { Fee } from "@automations/librus-data";
import { fakeRuntime, type Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { createWebFeeSource } from "./page-source.ts";

const html = readFileSync(new URL("./fixtures/organizer-fees.html", import.meta.url), "utf8");
const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
const CHILD1 = "00000000-0000-4000-8000-0000000000c1";
const config: Config = {
  family: { id: FAMILY_ID, name: "Example Family", timezone: "Europe/Warsaw", default_language: "en" },
  children: [{ id: CHILD1, family_id: FAMILY_ID, name: "Child One", has_librus: true, calendar_id: null }],
  accounts: [],
  activities: [],
  recipients: [
    { id: "r1", family_id: FAMILY_ID, telegram_chat_id: "1000001", language: "en", child_ids: [CHILD1] },
    { id: "r2", family_id: FAMILY_ID, telegram_chat_id: "1000002", language: "pl", child_ids: [] },
  ],
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
  dueDay: 15,
  notifyDay: 10,
  reminderDay: 14,
  amounts: { "2025-01": 15000, "2025-02": 20000 },
  sourceUrl: "https://organizer.example.com/fees",
  accountId: null,
  enabled: true,
};

function setup(respond: () => Response | Promise<Response>, row: Fee = fee) {
  const storage = createMemoryStorage({ configs: [config] });
  const runtime = fakeRuntime({ now: new Date("2025-01-12T08:00:00Z"), respond });
  const source = createWebFeeSource({ runtime, storage, familyId: FAMILY_ID });
  return { storage, runtime, source, row };
}

const ok = () => new Response(html, { status: 200 });

describe("createWebFeeSource", () => {
  it("uses the page amount when only the page has it", async () => {
    const { source } = setup(ok);
    expect(await source.amountFor({ ...fee, amounts: {} }, "2025-01")).toEqual({
      feeId: fee.id,
      month: "2025-01",
      amount: 15000,
      source: "page",
    });
  });

  it("uses the config amount when the Fee has no page address", async () => {
    const { source, runtime } = setup(ok);
    const found = await source.amountFor({ ...fee, sourceUrl: null }, "2025-01");
    expect(found).toMatchObject({ amount: 15000, source: "config" });
    expect(runtime.requests).toHaveLength(0);
  });

  it("uses the config amount when the page has no amount for the month", async () => {
    const { source } = setup(ok);
    expect(await source.amountFor({ ...fee, amounts: { "2025-04": 7000 } }, "2025-04")).toMatchObject({ amount: 7000, source: "config" });
  });

  it("gives nothing when neither the page nor the config has the month", async () => {
    const { source } = setup(ok);
    expect(await source.amountFor(fee, "2025-04")).toBeUndefined();
  });

  it("keeps one amount when the page and the config agree", async () => {
    const { source } = setup(ok);
    expect(await source.amountFor(fee, "2025-01")).toEqual({ feeId: fee.id, month: "2025-01", amount: 15000, source: "page" });
  });

  it("lets the page amount win and keeps the config amount when they differ", async () => {
    const { source } = setup(ok);
    expect(await source.amountFor(fee, "2025-02")).toEqual({
      feeId: fee.id,
      month: "2025-02",
      amount: 125050,
      source: "page",
      configAmount: 20000,
    });
  });

  it("uses the config amount and queues one failure Notification a day when the request fails", async () => {
    const { source, storage } = setup(() => new Response("error", { status: 503 }));
    expect(await source.amountFor(fee, "2025-01")).toMatchObject({ amount: 15000, source: "config" });
    await source.amountFor(fee, "2025-02");
    const pending = await storage.pendingNotifications(FAMILY_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ key: `failure:${fee.id}:2025-01-12:1000001`, chatId: "1000001" });
    expect(pending[0]?.text).toContain("Child One");
    expect(pending[0]?.text).toContain("HTTP 503");
  });

  it("treats a page without a fee table as a failure", async () => {
    const { source, storage } = setup(() => new Response("<p>Login</p>"));
    expect(await source.amountFor(fee, "2025-01")).toMatchObject({ source: "config" });
    expect(await storage.pendingNotifications(FAMILY_ID)).toHaveLength(1);
  });

  it("treats a network error as a failure", async () => {
    const { source, storage } = setup(() => Promise.reject(new Error("network down")));
    expect(await source.amountFor(fee, "2025-01")).toMatchObject({ source: "config" });
    expect((await storage.pendingNotifications(FAMILY_ID))[0]?.text).toContain("network down");
  });

  it("queues a new failure Notification on the next day", async () => {
    const { source, storage, runtime } = setup(() => new Response("", { status: 500 }));
    await source.amountFor(fee, "2025-01");
    runtime.setNow(new Date("2025-01-13T08:00:00Z"));
    await source.amountFor(fee, "2025-01");
    expect(await storage.pendingNotifications(FAMILY_ID)).toHaveLength(2);
  });
});
