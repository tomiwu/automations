import { fakeRuntime } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { createLibrusSource, fingerprint, lessonItem, timetableWeeks } from "./source.ts";
import { landingUrl, LibrusTimeoutError, loginIframeSource } from "./session.ts";
import { lesson } from "./test-fixtures.ts";

const ORIGIN = "https://school.example.org";
const account = { origin: ORIGIN, login_secret: "CHILD1_LIBRUS_LOGIN", password_secret: "CHILD1_LIBRUS_PASSWORD" };
const secrets = { CHILD1_LIBRUS_LOGIN: "login-value", CHILD1_LIBRUS_PASSWORD: "password-value" };

type Handler = (url: URL, init?: RequestInit) => Response | undefined;

/** A fake Librus: the login flow with redirects and cookies, then the handlers of the test. */
function librus(handlers: Handler[] = [], options: { reject?: boolean } = {}) {
  const runtime = fakeRuntime({
    secrets,
    now: new Date("2026-01-07T10:00:00Z"),
    respond: (input, init) => {
      const url = new URL(input);
      if (url.host === "portal.librus.pl") {
        return new Response('<iframe id="caLoginIframe" src="https://api.librus.pl/form"></iframe>', {
          headers: { "set-cookie": "portal=1; Path=/" },
        });
      }
      if (url.host === "api.librus.pl" && init?.method === "POST") {
        const reply = options.reject ? { status: "error" } : { status: "ok", goTo: "/landing" };
        return new Response(JSON.stringify(reply));
      }
      if (url.pathname === "/form") return new Response("", { status: 302, headers: { location: "/form2", "set-cookie": "a=b; Path=/" } });
      if (url.pathname === "/form2") return new Response("form");
      if (url.pathname === "/landing") return new Response("ok", { headers: { "set-cookie": ["SID=1; Path=/", "SID=deleted; Path=/x; Max-Age=0"].join(", ") } });
      for (const handler of handlers) {
        const response = handler(url, init);
        if (response) return response;
      }
      return new Response("not found", { status: 404 });
    },
  });
  return runtime;
}

const json = (body: unknown) => new Response(JSON.stringify(body));

describe("LibrusSource", () => {
  it("logs in with the secrets of the Account and reads grades", async () => {
    const runtime = librus([(url) => (url.pathname === "/przegladaj_oceny/uczen" ? new Response('<table><tr><td></td><td>Math</td><td><a class="ocena" href="/szczegoly/5">5</a></td></tr></table>') : undefined)]);
    const source = createLibrusSource(runtime, account, { timezone: "UTC" });
    expect(await source.currentItems("grades")).toEqual([{ id: "5", subject: "Math", grade: "5" }]);
    const post = runtime.requests.find((r) => r.init?.method === "POST");
    expect(String(post?.init?.body)).toBe("action=login&login=login-value&pass=password-value");
    expect((post?.init?.headers as Record<string, string>)["x-baner"]).toBeTruthy();
    await source.currentItems("grades");
    expect(runtime.requests.filter((r) => r.init?.method === "POST")).toHaveLength(1);
  });

  it("keeps the cookies of a redirect and sends them to the next hop", async () => {
    const runtime = librus();
    await createLibrusSource(runtime, account, { timezone: "UTC" }).currentItems("grades").catch(() => undefined);
    const next = runtime.requests.find((r) => r.input.endsWith("/form2"));
    expect((next?.init?.headers as Record<string, string>).cookie).toBe("a=b");
  });

  it("rejects when the login is rejected", async () => {
    const runtime = librus([], { reject: true });
    await expect(createLibrusSource(runtime, account, { timezone: "UTC" }).currentItems("grades")).rejects.toThrow("login rejected");
  });

  it("resolves names for homework and keeps only entries inside the window", async () => {
    const runtime = librus([
      (url) =>
        url.pathname.endsWith("/HomeWorks")
          ? json({ HomeWorks: [
              { Id: 1, Content: "Read", Date: "2026-01-09", Category: { Id: 2 }, Subject: { Id: 3 }, CreatedBy: { Id: 4 } },
              { Id: 2, Content: "Old", Date: "2025-12-01", Category: { Id: 2 }, Subject: { Id: 3 }, CreatedBy: { Id: 4 } },
            ] })
          : undefined,
      (url) => (url.pathname.endsWith("/Users/4") ? json({ User: { FirstName: "Teacher", LastName: "One" } }) : undefined),
      (url) => (url.pathname.endsWith("/Subjects/3") ? json({ Subject: { Name: "Math" } }) : undefined),
      (url) => (url.pathname.endsWith("/HomeWorks/Categories/2") ? json({ Category: { Name: "Test" } }) : undefined),
    ]);
    const source = createLibrusSource(runtime, account, { timezone: "UTC" });
    const [entry, ...rest] = await source.currentItems("homework");
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({ id: "1", category: "Test", subject: "Math", teacher: "Teacher One" });
    expect(runtime.requests.filter((r) => r.input.includes("/Users/4"))).toHaveLength(1);
  });

  it("reads trips, absences and substitutions", async () => {
    const runtime = librus([
      (url) => (url.pathname.endsWith("/SchoolTrips") ? json({ Data: [{ id: 1, termFrom: "2026-01-10" }] }) : undefined),
      (url) => (url.pathname.endsWith("/TeacherFreeDays") ? json({ TeacherFreeDays: [{ Id: 1, DateFrom: "2026-01-10", Teacher: { Id: 4 } }] }) : undefined),
      (url) => (url.pathname.endsWith("/Substitutions") ? json({ Substitutions: [{ Id: 1, OrgDate: "2026-01-10", OrgSubject: { Id: 3 }, Subject: { Id: 3 }, OrgTeacher: { Id: 4 }, Teacher: { Id: 4 } }] }) : undefined),
      (url) => (url.pathname.endsWith("/Users/4") ? json({ User: { FirstName: "Teacher", LastName: "One" } }) : undefined),
      (url) => (url.pathname.endsWith("/Subjects/3") ? json({ Subject: { Name: "Math" } }) : undefined),
    ]);
    const source = createLibrusSource(runtime, account, { timezone: "UTC" });
    expect(await source.currentItems("trips")).toHaveLength(1);
    expect((await source.currentItems("absences"))[0]).toMatchObject({ teacher: "Teacher One", hash: expect.any(String) });
    expect((await source.currentItems("substitutions"))[0]).toMatchObject({ orgSubject: "Math", teacher: "Teacher One" });
  });

  it("does not cache a failed name lookup", async () => {
    let calls = 0;
    const runtime = librus([
      (url) => (url.pathname.endsWith("/HomeWorks") ? json({ HomeWorks: [{ Id: 1, Date: "2026-01-09", Subject: { Id: 3 } }] }) : undefined),
      (url) => (url.pathname.endsWith("/Subjects/3") ? (calls++ === 0 ? json({}) : json({ Subject: { Name: "Math" } })) : undefined),
    ]);
    const source = createLibrusSource(runtime, account, { timezone: "UTC" });
    await expect(source.currentItems("homework")).rejects.toThrow("no name for Subjects/3");
    expect((await source.currentItems("homework"))[0]?.subject).toBe("Math");
  });

  it("opens a message body", async () => {
    const runtime = librus([(url) => (url.pathname.startsWith("/wiadomosci/1/5/m%201/") ? new Response('<div class="container-message-content">Hi</div>') : undefined)]);
    expect(await createLibrusSource(runtime, account, { timezone: "UTC" }).messageBody("m 1")).toBe("Hi");
  });

  it("reads the timetable of the next 14 days", async () => {
    const week = (date: string) => json({ Timetable: { [date]: [[{ LessonNo: "1", HourFrom: "08:00", HourTo: "08:45", Subject: { Name: "Math" } }]] } });
    const runtime = librus([
      (url) => (url.search === "?weekStart=2026-01-05" ? week("2026-01-07") : undefined),
      (url) => (url.search === "?weekStart=2026-01-12" ? json({ Timetable: {} }) : undefined),
      (url) => (url.search === "?weekStart=2026-01-19" ? week("2026-01-20") : undefined),
    ]);
    const source = createLibrusSource(runtime, account, { timezone: "UTC" });
    const { lessons, error } = await source.fullTimetable();
    expect(error).toBeUndefined();
    expect(lessons.map((l) => l.date)).toEqual(["2026-01-07", "2026-01-20"]);
  });

  it("gives an empty timetable and the reason when Librus fails", async () => {
    const runtime = librus([], { reject: true });
    const result = await createLibrusSource(runtime, account, { timezone: "UTC" }).fullTimetable();
    expect(result.lessons).toEqual([]);
    expect(result.error).toContain("login rejected");
  });

  it("fails fast after a timeout", async () => {
    const runtime = fakeRuntime({
      secrets,
      respond: () => {
        throw Object.assign(new Error("slow"), { name: "TimeoutError" });
      },
    });
    const source = createLibrusSource(runtime, account, { timezone: "UTC" });
    await expect(source.currentItems("grades")).rejects.toBeInstanceOf(LibrusTimeoutError);
    const count = runtime.requests.length;
    await expect(source.currentItems("grades")).rejects.toBeInstanceOf(LibrusTimeoutError);
    expect(runtime.requests.length).toBe(count);
  });

  it("rejects a page without access and an answer that is not JSON", async () => {
    const runtime = librus([
      (url) => (url.pathname === "/wiadomosci" ? new Response("Brak dostępu") : undefined),
      (url) => (url.pathname.endsWith("/SchoolTrips") ? new Response("<html>") : undefined),
      (url) => (url.pathname.endsWith("/Calendars/TeacherFreeDays") ? new Response("Brak dostępu") : undefined),
    ]);
    const source = createLibrusSource(runtime, account, { timezone: "UTC" });
    await expect(source.currentItems("messages")).rejects.toThrow("no access");
    await expect(source.currentItems("trips")).rejects.toThrow("unexpected response");
    await expect(source.currentItems("absences")).rejects.toThrow("no access");
  });

  it("loops on redirects only up to a limit", async () => {
    const runtime = librus([(url) => (url.pathname === "/wiadomosci" ? new Response("", { status: 302, headers: { location: "/wiadomosci" } }) : undefined)]);
    await expect(createLibrusSource(runtime, account, { timezone: "UTC" }).currentItems("messages")).rejects.toThrow("too many redirects");
  });
});

describe("helpers", () => {
  it("lessonItem builds the ID and the hash", () => {
    expect(lessonItem(lesson("2026-01-09", 2, "Math", { status: "substitution", substituteTeacher: "Teacher Two" }))).toMatchObject({
      id: "2026-01-09:2",
      hash: "substitution|Teacher Two",
    });
  });

  it("fingerprint is stable and differs for different text", () => {
    expect(fingerprint("a")).toBe(fingerprint("a"));
    expect(fingerprint("a")).not.toBe(fingerprint("b"));
  });

  it("timetableWeeks lists the Mondays", () => {
    expect(timetableWeeks("2026-01-07", "2026-01-20")).toEqual(["2026-01-05", "2026-01-12", "2026-01-19"]);
  });

  it("landingUrl checks the answer of the login form", () => {
    expect(landingUrl('{"status":"ok","goTo":"/x"}', 200, "https://a.example/form")).toBe("https://a.example/x");
    expect(() => landingUrl("nope", 500, "https://a.example/")).toThrow("HTTP 500");
    expect(() => landingUrl('{"status":"error"}', 200, "https://a.example/")).toThrow("login rejected");
  });
});

describe("loginIframeSource", () => {
  it("finds the iframe of the current portal by its src and decodes the ampersand", () => {
    const html =
      '<iframe title="Zaloguj do Synergii - formularz" class="x__iframe " src="https://synergia.librus.pl/loguj/portalRodzina?layout_version=2&amp;v=1793712592" allow="publickey-credentials-get"></iframe>';
    expect(loginIframeSource(html)).toBe("https://synergia.librus.pl/loguj/portalRodzina?layout_version=2&v=1793712592");
  });

  it("still finds the old iframe by its id", () => {
    expect(loginIframeSource('<iframe id="caLoginIframe" src="https://api.librus.pl/form"></iframe>')).toBe("https://api.librus.pl/form");
  });

  it("ignores other iframes and returns nothing without a login iframe", () => {
    expect(loginIframeSource('<iframe src="https://ads.example.com/banner"></iframe>')).toBeUndefined();
  });
});
