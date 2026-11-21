import type { Config } from "@automations/shared";
import type { ItemsByWatcher, LibrusSource, Lesson, TimetableResult, WatcherName } from "./types.ts";

export const FAMILY_ID = "00000000-0000-4000-8000-000000000001";
export const CHILD1 = "00000000-0000-4000-8000-0000000000c1";
export const CHILD2 = "00000000-0000-4000-8000-0000000000c2";
export const ACCOUNT1 = "00000000-0000-4000-8000-0000000000a1";

/** Invented config: two Children, one with Librus, one Recipient for each language. */
export function testConfig(): Config {
  const base = { family_id: FAMILY_ID };
  return {
    family: { id: FAMILY_ID, name: "Example Family", timezone: "UTC", default_language: "en" },
    children: [
      { ...base, id: CHILD1, name: "Child One", has_librus: true, calendar_id: null },
      { ...base, id: CHILD2, name: "Child Two", has_librus: false, calendar_id: null },
    ],
    accounts: [
      {
        ...base,
        id: ACCOUNT1,
        child_id: CHILD1,
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
      { ...base, id: "r1", telegram_chat_id: "1000001", language: "en", child_ids: [CHILD1] },
      { ...base, id: "r2", telegram_chat_id: "1000002", language: "pl", child_ids: [CHILD1, CHILD2] },
      { ...base, id: "r3", telegram_chat_id: "1000003", language: "en", child_ids: [CHILD2] },
    ],
  };
}

export interface FakeSource extends LibrusSource {
  items: Partial<{ [W in WatcherName]: ItemsByWatcher[W] }>;
  lessons: Lesson[];
  timetableError?: string;
  bodies: string[];
  opened: string[];
  attachmentBytes: Map<string, Uint8Array>;
}

/** A source with data that the test changes. */
export function fakeSource(): FakeSource {
  const source: FakeSource = {
    items: {},
    lessons: [],
    bodies: [],
    opened: [],
    attachmentBytes: new Map(),
    async currentItems(watcher, since) {
      const items = (source.items[watcher] ?? []) as { date?: string }[];
      return (since === undefined ? items : items.filter((i) => (i.date ?? since) >= since)) as never;
    },
    async messageBody(id) {
      return (await source.openMessage(id)).body;
    },
    async openMessage(id) {
      source.opened.push(id);
      source.bodies.push(id);
      return { body: `Body of ${id}`, attachments: [] };
    },
    async fetchAttachment(path) {
      return source.attachmentBytes.get(path) ?? new Uint8Array([1, 2, 3]);
    },
    async fullTimetable(): Promise<TimetableResult> {
      return source.timetableError ? { lessons: [], error: source.timetableError } : { lessons: source.lessons };
    },
    async timetable() {
      return source.fullTimetable();
    },
  };
  return source;
}

export function lesson(date: string, period: number, subject: string, extra: Partial<Lesson> = {}): Lesson {
  return {
    date,
    period,
    start: `0${7 + period}:00`,
    end: `0${7 + period}:45`,
    subject,
    teacher: "Teacher One",
    room: "1",
    status: "normal",
    substituteTeacher: "",
    ...extra,
  };
}
