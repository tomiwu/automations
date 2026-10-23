import type { Config } from "@automations/shared";
import type { Fee } from "./storage.ts";

export const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
export const OTHER_FAMILY_ID = "00000000-0000-4000-8000-000000000002";
export const FEE_ID = "00000000-0000-4000-8000-0000000000f1";

/** Invented Fee for tests. */
export function exampleFee(overrides: Partial<Fee> = {}): Fee {
  return {
    id: FEE_ID,
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
    amounts: { "2025-01": 15000 },
    sourceUrl: null,
    accountId: null,
    enabled: true,
    ...overrides,
  };
}

/** Invented config for tests. */
export function exampleConfig(familyId: string = FAMILY_ID): Config {
  const childId = "00000000-0000-4000-8000-0000000000c1";
  return {
    family: { id: familyId, name: "Example Family", timezone: "UTC", default_language: "en" },
    children: [{ id: childId, family_id: familyId, name: "Child One", has_librus: true, calendar_id: null }],
    accounts: [
      {
        id: "00000000-0000-4000-8000-0000000000a1",
        family_id: familyId,
        child_id: childId,
        service: "librus",
        origin: "https://school.example.org",
        group: null,
        login_secret: "CHILD1_LIBRUS_LOGIN",
        password_secret: "CHILD1_LIBRUS_PASSWORD",
        enabled: true,
      },
    ],
    activities: [],
    recipients: [
      {
        id: "00000000-0000-4000-8000-0000000000b1",
        family_id: familyId,
        telegram_chat_id: "1000001",
        language: "en",
        child_ids: [childId],
      },
    ],
  };
}
