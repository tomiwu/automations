import { fakeRuntime } from "@automations/shared";

/**
 * Invented Librus-shaped data for the days-off fixture test (issue #201): Child One at Example School,
 * the weeks of 2026-11-09 and 2026-11-16, a school break on Thursday 2026-11-12 and Friday 2026-11-13.
 */
export const ORIGIN = "https://school.example.org";

const SUBJECTS = ["Example Math", "Example Science"];
const SCHOOL_DAYS = [
  "2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13",
  "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20",
];

const lessonJson = (period: number) => ({
  LessonNo: String(period),
  HourFrom: `0${7 + period}:00`,
  HourTo: `0${7 + period}:45`,
  Subject: { Name: SUBJECTS[period - 1] },
  Teacher: { FirstName: "Teacher", LastName: "One" },
  Classroom: { Symbol: String(period) },
  IsCanceled: false,
  IsSubstitutionClass: false,
});

/** The `Timetables?weekStart=` answer of one week: two Lessons on each school day. */
export function timetableJson(weekStart: string): unknown {
  const days = SCHOOL_DAYS.filter((date) => date >= weekStart && date < addDays(weekStart, 7));
  return { Timetable: Object.fromEntries(days.map((date) => [date, [[lessonJson(1)], [lessonJson(2)]]])) };
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

/** The school break: one `SchoolFreeDays` entry for 2026-11-12 to 2026-11-13. */
export const SCHOOL_FREE_DAYS = { SchoolFreeDays: [{ Id: 701, DateFrom: "2026-11-12", DateTo: "2026-11-13", Name: "Example school break" }] };

/** One class day off on 2026-11-18 (no `DateTo`: one day). */
export const CLASS_FREE_DAYS = { ClassFreeDays: [{ Id: 702, DateFrom: "2026-11-18", Name: "Example class day off" }] };

/** A free-text calendar note. It says "no school", but it is not a day off, so it cancels nothing. */
export const HOMEWORKS = { HomeWorks: [{ Id: 703, Content: "No school on 2026-11-11 (free text note)", Date: "2026-11-11" }] };

export interface FixtureData {
  schoolFreeDays?: unknown;
  classFreeDays?: unknown;
}

const json = (body: unknown) => new Response(JSON.stringify(body));

/** The gateway answers by path. Any other path (names of Users, Subjects, Categories) gets `{}`. */
function gatewayAnswers(data: FixtureData): Record<string, (query: URLSearchParams) => unknown> {
  return {
    Timetables: (query) => timetableJson(query.get("weekStart") ?? ""),
    SchoolFreeDays: () => data.schoolFreeDays ?? { SchoolFreeDays: [] },
    ClassFreeDays: () => data.classFreeDays ?? { ClassFreeDays: [] },
    HomeWorks: () => HOMEWORKS,
    SchoolTrips: () => ({ Data: [] }),
    "Calendars/TeacherFreeDays": () => ({ TeacherFreeDays: [] }),
    "Calendars/Substitutions": () => ({ Substitutions: [] }),
    ParentTeacherConferences: () => ({ ParentTeacherConferences: [] }),
  };
}

type LoginStep = [match: (url: URL, init?: RequestInit) => boolean, answer: () => Response];

/** The login flow of the fake Librus, in order. */
const LOGIN_STEPS: LoginStep[] = [
  [(url) => url.host === "portal.librus.pl", () => new Response('<iframe id="caLoginIframe" src="https://api.librus.pl/form"></iframe>')],
  [(url, init) => url.host === "api.librus.pl" && init?.method === "POST", () => json({ status: "ok", goTo: `${ORIGIN}/landing` })],
  [(url) => url.host === "api.librus.pl", () => new Response("form")],
  [(url) => url.pathname === "/landing", () => new Response("ok", { headers: { "set-cookie": "SID=1; Path=/" } })],
];

const PREFIX = "/gateway/api/2.0/";

function gatewayAnswer(url: URL, data: FixtureData): Response {
  const answer = gatewayAnswers(data)[url.pathname.slice(PREFIX.length)];
  return json(answer ? answer(url.searchParams) : {});
}

function schoolAnswer(url: URL, data: FixtureData): Response {
  if (url.origin !== ORIGIN) throw new Error(`No network in this test: ${url.host}`);
  return url.pathname.startsWith(PREFIX) ? gatewayAnswer(url, data) : new Response("<html><body></body></html>");
}

/**
 * A fake Librus with no network: the login flow, the gateway answers of the fixture, and an empty page
 * for each HTML page. A request to any other host throws.
 */
export function fakeLibrusRuntime(now: Date, data: FixtureData) {
  return fakeRuntime({
    now,
    secrets: { CHILD1_LIBRUS_LOGIN: "login-value", CHILD1_LIBRUS_PASSWORD: "password-value" },
    respond: (input, init) => {
      const url = new URL(input);
      const step = LOGIN_STEPS.find(([match]) => match(url, init));
      return step ? step[1]() : schoolAnswer(url, data);
    },
  });
}
