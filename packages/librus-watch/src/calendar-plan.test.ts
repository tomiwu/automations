import { describe, expect, it } from "vitest";
import {
  markerOf,
  planCalendar,
  type CalendarPlan,
  type CalendarState,
  type ExistingEvent,
  type PlanLesson,
  type PlanSession,
} from "./calendar-plan.ts";

const lesson = (extra: Partial<PlanLesson> = {}): PlanLesson => ({
  calendarId: "cal-one",
  prefix: "Child One",
  date: "2026-11-12",
  period: 1,
  start: "08:00",
  end: "08:45",
  subject: "Example Math",
  status: "normal",
  ...extra,
});

const session = (extra: Partial<PlanSession> = {}): PlanSession => ({
  calendarId: "cal-two",
  prefix: "Child Two",
  service: "examplesport",
  date: "2026-11-12",
  start: "17:00",
  end: "18:00",
  activity: "Example Swimming",
  status: "planned",
  place: "Example Pool",
  teacher: "Coach One",
  ...extra,
});

function fakeCalendar(initial: ExistingEvent[] = []) {
  let events = [...initial];
  let next = 1;
  return {
    events: () => events,
    apply(plan: CalendarPlan) {
      for (const update of plan.updates) events = events.map((event) => (event.id === update.id ? update : event));
      for (const create of plan.creates) events.push({ ...create, id: `e${next++}` });
    },
  };
}

const empty: CalendarPlan = { creates: [], updates: [] };

describe("planCalendar", () => {
  it("is idempotent: run 2 on the same state plans nothing", () => {
    const state: CalendarState = {
      lessons: [lesson(), lesson({ period: 2, start: "08:55", end: "09:40", homework: ["Kartkówka"] })],
      sessions: [session(), session({ date: "2026-11-13", status: "cancelled", place: undefined, teacher: undefined, note: "Example note" })],
    };
    const calendar = fakeCalendar();
    const first = planCalendar(state, calendar.events());
    expect(first.creates).toHaveLength(4);
    expect(first.updates).toEqual([]);
    calendar.apply(first);
    expect(planCalendar(state, calendar.events())).toEqual(empty);
  });

  it("writes the titles, descriptions and markers of the contract", () => {
    const { creates } = planCalendar(
      { lessons: [lesson({ status: "substitution", substituteTeacher: "Teacher Two", homework: ["Zadanie"] })], sessions: [session({ note: "Bring a cap" })] },
      [],
    );
    expect(creates).toEqual([
      {
        calendarId: "cal-one",
        summary: "Child One: 1. Example Math 📚 Zadanie",
        description: "Zastępstwo: Teacher Two\n[librus-lesson: 2026-11-12-1]",
        start: "2026-11-12T08:00",
        end: "2026-11-12T08:45",
        location: "",
      },
      {
        calendarId: "cal-two",
        summary: "Child Two: Example Swimming",
        description: "Miejsce: Example Pool\nProwadzący: Coach One\nUwaga: Bring a cap\n[activity: examplesport-2026-11-12-17:00]",
        start: "2026-11-12T17:00",
        end: "2026-11-12T18:00",
        location: "Example Pool",
      },
    ]);
  });

  it("a Lesson on a day off gives one update with the day-off token, once", () => {
    const calendar = fakeCalendar();
    calendar.apply(planCalendar({ lessons: [lesson()], sessions: [] }, []));
    const state: CalendarState = { lessons: [lesson({ status: "cancelled", cancelReason: { reason: "day_off" } })], sessions: [] };
    const plan = planCalendar(state, calendar.events());
    expect(plan.creates).toEqual([]);
    expect(plan.updates.map((event) => event.summary)).toEqual(["Child One: 1. Example Math [ODWOŁANA] (dzień wolny)"]);
    calendar.apply(plan);
    expect(planCalendar(state, calendar.events())).toEqual(empty);
    expect(calendar.events()[0]!.summary.split("[ODWOŁANA]")).toHaveLength(2);
  });

  it("a cancelled Lesson without a day off and a cancelled session get their tokens", () => {
    const { creates } = planCalendar({ lessons: [lesson({ status: "cancelled", cancelReason: null })], sessions: [session({ status: "cancelled" })] }, []);
    expect(creates.map((event) => event.summary)).toEqual(["Child One: 1. Example Math [ODWOŁANA]", "Child Two: Example Swimming [ODWOŁANE]"]);
  });

  it("a vanished item gets one update with [usunięte?], never a delete, and the token once", () => {
    const calendar = fakeCalendar();
    calendar.apply(planCalendar({ lessons: [lesson()], sessions: [session()] }, []));
    const state: CalendarState = { lessons: [lesson({ vanished: true })], sessions: [session({ vanished: true })] };
    const plan = planCalendar(state, calendar.events());
    expect(Object.keys(plan).sort()).toEqual(["creates", "updates"]);
    expect(plan.updates.map((event) => event.summary)).toEqual(["Child One: 1. Example Math [usunięte?]", "Child Two: Example Swimming [usunięte?]"]);
    calendar.apply(plan);
    expect(calendar.events()).toHaveLength(2);
    expect(planCalendar(state, calendar.events())).toEqual(empty);
  });

  it("a changed time gives one update and no create", () => {
    const calendar = fakeCalendar();
    calendar.apply(planCalendar({ lessons: [lesson()], sessions: [] }, []));
    const plan = planCalendar({ lessons: [lesson({ start: "09:00", end: "09:45" })], sessions: [] }, calendar.events());
    expect(plan.creates).toEqual([]);
    expect(plan.updates).toEqual([expect.objectContaining({ id: "e1", start: "2026-11-12T09:00", end: "2026-11-12T09:45" })]);
  });

  it("two Children with the same date and period have different keys and no cross update", () => {
    const other = lesson({ calendarId: "cal-two", prefix: "Child Two", subject: "Example Art" });
    const calendar = fakeCalendar();
    calendar.apply(planCalendar({ lessons: [lesson(), other], sessions: [] }, []));
    expect(calendar.events()).toHaveLength(2);
    const plan = planCalendar({ lessons: [lesson({ status: "cancelled" }), other], sessions: [] }, calendar.events());
    expect(plan.creates).toEqual([]);
    expect(plan.updates.map((event) => [event.id, event.calendarId])).toEqual([["e1", "cal-one"]]);
  });

  it("never touches an event without a marker, and leaves an event that the state does not name", () => {
    const manual: ExistingEvent = { id: "m1", calendarId: "cal-one", summary: "Example manual event", description: "Notes", start: "2026-11-12T08:00", end: "2026-11-12T09:00", location: "" };
    const old: ExistingEvent = { ...manual, id: "o1", summary: "Child One: 3. Old", description: "[librus-lesson: 2026-11-10-3]" };
    const plan = planCalendar({ lessons: [lesson()], sessions: [] }, [manual, old]);
    expect(plan.updates).toEqual([]);
    expect(plan.creates).toHaveLength(1);
  });

  it("plans one create for a Lesson that is twice in the state", () => {
    expect(planCalendar({ lessons: [lesson(), lesson()], sessions: [] }, []).creates).toHaveLength(1);
  });
});

describe("markerOf", () => {
  it("reads the key marker on the last line only", () => {
    expect(markerOf("Zastępstwo: X\n[librus-lesson: 2026-11-12-1]\n")).toBe("[librus-lesson: 2026-11-12-1]");
    expect(markerOf("[librus-msg: 7]")).toBe("[librus-msg: 7]");
    expect(markerOf("[librus-lesson: 2026-11-12-1]\nmore text")).toBeNull();
    expect(markerOf("[other: 1]")).toBeNull();
    expect(markerOf("")).toBeNull();
  });
});
