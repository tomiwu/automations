import { createMemoryStorage } from "@automations/librus-data";
import { fakeRuntime } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { createAfterSchool, formatAfterSchool } from "./after-school.ts";
import type { CollectDeps } from "./collect-sessions.ts";
import { afterSchoolExport, parseAfterSchoolInput, sessionsExport } from "./exports.ts";
import { CHILD1, CHILD2, FAMILY_ID, danceActivity, fakeSessionSource, session, testConfig } from "./test-fixtures.ts";
import type { CreateSource } from "./source.ts";
import type { Session } from "./sessions.ts";

const day = "2026-10-27";
const sessions: Session[] = [
  session({ start: `${day}T17:00`, end: `${day}T18:00`, activity: "Chess", place: "", id: "b" }),
  session(),
  session({ start: `${day}T16:30`, end: `${day}T17:00`, activity: "Art", status: "cancelled", id: "c" }),
  session({ start: `${day}T18:00`, end: `${day}T19:00`, activity: "Swim", status: "moved", id: "d" }),
  session({ start: "2026-10-28T15:00", id: "e" }),
  session({ childId: CHILD2, child: "Child Two", id: "f" }),
];

describe("formatAfterSchool", () => {
  it("lists the Sessions of the Child on the day in time order, with the status", () => {
    expect(formatAfterSchool("en", CHILD1, day, sessions)).toBe(
      [
        "After school:",
        "• 15:00-16:00 Choir (Example Hall)",
        "• 16:30-17:00 Art (Example Hall) - cancelled",
        "• 17:00-18:00 Chess",
        "• 18:00-19:00 Swim (Example Hall) - moved",
      ].join("\n"),
    );
  });

  it("renders in Polish", () => {
    expect(formatAfterSchool("pl", CHILD1, day, [session({ status: "cancelled" })])).toBe(
      "Po szkole:\n• 15:00-16:00 Choir (Example Hall) - odwołane",
    );
  });

  it("says so when there is no class, and adds a warning when an Account failed", () => {
    expect(formatAfterSchool("en", CHILD1, "2026-10-29", sessions)).toBe("After school:\nNo activities after school today.");
    expect(formatAfterSchool("en", CHILD1, "2026-10-29", [], ["x"])).toBe(
      "After school:\nNo activities after school today.\nSome activity apps could not be read.",
    );
  });
});

function deps(): CollectDeps & { calls: string[] } {
  const config = testConfig();
  const calls: string[] = [];
  const createSource: CreateSource = (target) => {
    calls.push(target.account.id);
    return fakeSessionSource(target.child.id === CHILD1 ? [session()] : [session({ childId: CHILD2, child: "Child Two", activity: danceActivity.name })]);
  };
  return {
    runtime: fakeRuntime(),
    storage: createMemoryStorage({ configs: [config] }),
    familyId: FAMILY_ID,
    createSource,
    calls,
  };
}

describe("createAfterSchool", () => {
  it("reads only the Accounts of the Child", async () => {
    const d = deps();
    const text = await createAfterSchool(d)({ id: CHILD1, name: "Child One" }, day, "en");
    expect(text).toContain("15:00-16:00 Choir");
    expect(d.calls).toHaveLength(1);
  });
});

describe("exports", () => {
  it("sessionsExport gives the Sessions of all Children and rejects any input key", async () => {
    const result = await sessionsExport(deps());
    expect(result.sessions.map((s) => s.childId).sort()).toEqual([CHILD1, CHILD2]);
    await expect(sessionsExport(deps(), { childId: CHILD1 })).rejects.toThrow(/Unknown input key/);
    await expect(sessionsExport(deps(), [])).rejects.toThrow(/must be an object/);
    await expect(sessionsExport(deps(), null)).rejects.toThrow(/must be an object/);
  });

  it("sessionsExport gives an error text for an Account that fails", async () => {
    const d = deps();
    const failing: CreateSource = (target) => {
      const source = fakeSessionSource([]);
      if (target.child.id === CHILD2) source.error = new Error("down");
      return source;
    };
    const result = await sessionsExport({ ...d, createSource: failing });
    expect(result.errors).toEqual(["Child Two edusky: down"]);
  });

  it("afterSchoolExport uses the language of the input, or the default language of the Family", async () => {
    const d = deps();
    expect(await afterSchoolExport(d, { childId: CHILD1, day, language: "pl" })).toEqual({
      text: "Po szkole:\n• 15:00-16:00 Choir (Example Hall)",
    });
    expect((await afterSchoolExport(d, { childId: CHILD1, day })).text).toMatch(/^After school:/);
    await expect(afterSchoolExport(d, { childId: "missing", day })).rejects.toThrow(/Unknown child/);
  });

  it("parseAfterSchoolInput checks the input", () => {
    expect(parseAfterSchoolInput({ childId: "c", day })).toEqual({ childId: "c", day, language: undefined });
    expect(() => parseAfterSchoolInput({ childId: "c", day, extra: 1 })).toThrow(/Unknown input key/);
    expect(() => parseAfterSchoolInput({ childId: "", day })).toThrow(/childId/);
    expect(() => parseAfterSchoolInput({ childId: "c", day: "27.10.2026" })).toThrow(/YYYY-MM-DD/);
    expect(() => parseAfterSchoolInput({ childId: "c", day, language: "de" })).toThrow(/language/);
  });
});
