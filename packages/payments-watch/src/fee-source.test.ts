import { createMemoryStorage } from "@automations/librus-data";
import type { Fee } from "@automations/librus-data";
import { describe, expect, it } from "vitest";
import { createConfigFeeSource } from "./fee-source.ts";

const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
const fee: Fee = {
  id: "00000000-0000-4000-8000-0000000000f1",
  familyId: FAMILY_ID,
  childId: "00000000-0000-4000-8000-0000000000c1",
  organizer: "Example Organizer",
  recipientName: "Example Recipient",
  nip: null,
  account: "61109010140000071219812874",
  title: "Example fee",
  dueDay: 15,
  notifyDay: 10,
  reminderDay: 14,
  amounts: { "2025-01": 15000, "2025-02": 0 },
  sourceUrl: null,
  accountId: null,
  enabled: true,
};

async function storedFee(): Promise<Fee> {
  const storage = createMemoryStorage();
  storage.setFee(fee);
  const [stored] = await storage.listFees(FAMILY_ID);
  return stored!;
}

describe("createConfigFeeSource", () => {
  it("returns the amount of the month from the stored Fee", async () => {
    expect(await createConfigFeeSource().amountFor(await storedFee(), "2025-01")).toEqual({
      feeId: fee.id,
      month: "2025-01",
      amount: 15000,
      source: "config",
    });
  });

  it("returns nothing when the month has no amount", async () => {
    expect(await createConfigFeeSource().amountFor(await storedFee(), "2025-03")).toBeUndefined();
  });

  it("returns an amount of 0 as it is", async () => {
    expect((await createConfigFeeSource().amountFor(await storedFee(), "2025-02"))?.amount).toBe(0);
  });
});
