import { createMemoryStorage, type StorageAdapter } from "@automations/librus-data";
import type { Account, Activity, Config } from "@automations/shared";
import type { Session } from "./sessions.ts";
import type { SessionSource } from "./targets.ts";

export const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
export const CHILD1 = "00000000-0000-4000-8000-0000000000c1";
export const CHILD2 = "00000000-0000-4000-8000-0000000000c2";
export const NOW_ACCOUNT = "00000000-0000-4000-8000-0000000000a1";
export const EDUSKY_ACCOUNT = "00000000-0000-4000-8000-0000000000a2";
export const ACTIVITY1 = "00000000-0000-4000-8000-0000000000d1";
export const ACTIVITY2 = "00000000-0000-4000-8000-0000000000d2";

export const SECRETS = {
  CHILD1_ACTIVENOW_LOGIN: "login-one",
  CHILD1_ACTIVENOW_PASSWORD: "password one",
  CHILD2_EDUSKY_LOGIN: "login-two",
  CHILD2_EDUSKY_PASSWORD: "password&two",
  EDUSKY_CLIENT_SECRET: "client-secret",
};

const base = { family_id: FAMILY_ID };

export const activeNowAccount: Account = {
  ...base,
  id: NOW_ACCOUNT,
  child_id: CHILD1,
  service: "activenow",
  origin: "https://activenow.example.org",
  group: "Child One",
  login_secret: "CHILD1_ACTIVENOW_LOGIN",
  password_secret: "CHILD1_ACTIVENOW_PASSWORD",
  enabled: true,
};

export const eduskyAccount: Account = {
  ...base,
  id: EDUSKY_ACCOUNT,
  child_id: CHILD2,
  service: "edusky",
  origin: "https://organizer.edusky.example.org",
  group: "Group Blue",
  login_secret: "CHILD2_EDUSKY_LOGIN",
  password_secret: "CHILD2_EDUSKY_PASSWORD",
  enabled: true,
};

export const choirActivity: Activity = {
  ...base,
  id: ACTIVITY1,
  child_id: CHILD1,
  account_id: NOW_ACCOUNT,
  name: "Choir",
  weekday: 2,
  start_time: "15:00",
  end_time: "16:00",
  place: "Example Hall",
  enabled: true,
};

export const danceActivity: Activity = {
  ...base,
  id: ACTIVITY2,
  child_id: CHILD2,
  account_id: EDUSKY_ACCOUNT,
  name: "Dance",
  weekday: 3,
  start_time: "16:00",
  end_time: "17:00",
  place: null,
  enabled: true,
};

/** Invented config: two Children, an ActiveNow Account, an Edusky Account and Recipients in both languages. */
export function testConfig(): Config {
  return {
    family: { id: FAMILY_ID, name: "Example Family", timezone: "UTC", default_language: "en" },
    children: [
      { ...base, id: CHILD1, name: "Child One", has_librus: true, calendar_id: null },
      { ...base, id: CHILD2, name: "Child Two", has_librus: false, calendar_id: null },
    ],
    accounts: [activeNowAccount, eduskyAccount],
    activities: [choirActivity, danceActivity],
    recipients: [
      { ...base, id: "r1", telegram_chat_id: "1000001", language: "en", child_ids: [CHILD1] },
      { ...base, id: "r2", telegram_chat_id: "1000002", language: "pl", child_ids: [CHILD1, CHILD2] },
      { ...base, id: "r3", telegram_chat_id: "1000003", language: "en", child_ids: [CHILD2] },
    ],
  };
}

/** Makes one Session of Child One. */
export function session(overrides: Partial<Session> = {}): Session {
  return {
    childId: CHILD1,
    child: "Child One",
    activity: "Choir",
    service: "activenow",
    start: "2026-10-27T15:00",
    end: "2026-10-27T16:00",
    place: "Example Hall",
    status: "planned",
    source: "app",
    id: `${ACTIVITY1}:2026-10-27:15:00`,
    ...overrides,
  };
}

export interface FakeSessionSource extends SessionSource {
  current: Session[];
  error?: Error;
}

/** A source with Sessions that the test changes. */
export function fakeSessionSource(current: Session[] = []): FakeSessionSource {
  const source: FakeSessionSource = {
    current,
    async sessions() {
      if (source.error) throw source.error;
      return source.current;
    },
  };
  return source;
}

interface CardOptions {
  date: string;
  original?: string;
  struck?: boolean;
  time?: string;
  title?: string;
  place?: string;
  badges?: string[];
}

/** One card in the shape of the ActiveNow lessons page. The place is in a template, like on the real page. */
export function card({
  date,
  original,
  struck = false,
  time = "15:00 - 16:00",
  title = "Group Blue",
  place = "Example Hall",
  badges = [],
}: CardOptions): string {
  const dateClass = struck ? "text-grey-400 line-through" : "text-grey-700";
  const old = original ? `<span class="ml-1 text-sm font-normal text-grey-400 line-through">${original}</span>` : "";
  const chips = badges
    .map((b) => `<div class="group w-fit rounded-full"><div><p class="pl-3 font-semibold">${b}</p></div></div>`)
    .join("");
  return `<div class="group/card w-full" data-controller="card"><div class="p-4"><div class="relative w-full"><div class="min-w-0">
<div class="flex flex-col font-semibold"><div class="${dateClass}">${date}${old}</div><div class="text-xs text-grey-600">${time}</div></div>
<div class="min-w-0 flex flex-col"><div class="mt-2 line-clamp-3 text-grey-500 text-xs font-semibold ">${title} </div><div class="mt-3 flex flex-row flex-wrap gap-2">${chips}</div></div></div></div></div>
<template><div class="px-4 py-4"><div class="flex items-center"><div class="-ml-1 mr-1"><span class="svg-icon location_on_20-icon"></span></div><div class="text-grey-600"><span>${place}</span></div></div></div></template></div>`;
}

/** A month section of the lessons page. */
export function month(isoMonth: string, ...cards: string[]): string {
  return `<div class="flex flex-col gap-3" data-navigation-date="${isoMonth}"><h3 class="label">${isoMonth}</h3>${cards.join("")}</div>`;
}

/** A storage that reads the config and throws on every other call: a read-only probe must not write. */
export function readOnlyStorage(config: Config): StorageAdapter {
  const storage = createMemoryStorage({ configs: [config] });
  return new Proxy(storage, {
    get(target, name) {
      if (name === "loadConfig") return target.loadConfig.bind(target);
      throw new Error(`The probe used storage.${String(name)}`);
    },
  });
}
