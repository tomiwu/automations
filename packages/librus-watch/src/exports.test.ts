import { createMemoryStorage } from "@automations/librus-data";
import { fakeRuntime } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { childrenExport, lessonsExport, parseExportInput, pickTarget, upcomingExport, type ExportDeps } from "./exports.ts";
import { CHILD1, CHILD2, FAMILY_ID, fakeSource, lesson, testConfig } from "./test-fixtures.ts";
import { librusTargets } from "./run.ts";

function setup() {
  const config = testConfig();
  const source = fakeSource();
  source.lessons = [lesson("2026-01-07", 1, "Math")];
  source.items.homework = [{ id: "1", hash: "a", category: "Test", date: "2026-01-07", content: "", subject: "Math", teacher: "" }];
  const deps: ExportDeps = {
    runtime: fakeRuntime({ now: new Date("2026-01-07T10:00:00Z") }),
    storage: createMemoryStorage({ configs: [config] }),
    familyId: FAMILY_ID,
    createSource: () => source,
  };
  return { config, deps };
}

describe("exports", () => {
  it("children lists id, name and calendar_id of every Child", async () => {
    const { config, deps } = setup();
    config.children[0]!.calendar_id = "calendar-1";
    const result = await childrenExport({ ...deps, storage: createMemoryStorage({ configs: [config] }) }, {});
    expect(result).toEqual({
      children: [
        { id: CHILD1, name: "Child One", calendar_id: "calendar-1" },
        { id: CHILD2, name: "Child Two", calendar_id: null },
      ],
    });
  });

  it("children takes no input", async () => {
    const { deps } = setup();
    await expect(childrenExport(deps, { x: 1 })).rejects.toThrow("Unknown input key(s): x.");
    await expect(childrenExport(deps, [])).rejects.toThrow("Input must be an object.");
  });

  it("upcoming includes childId and the name of the Child", async () => {
    const { deps } = setup();
    const result = await upcomingExport(deps, { days: 5 });
    expect(result).toMatchObject({ childId: CHILD1, child: "Child One", timezone: "UTC", from: "2026-01-07", to: "2026-01-12", timetableOk: true });
    expect(result.entries[0]).toMatchObject({ childId: CHILD1, child: "Child One", start: "08:00" });
  });

  it("lessons includes childId and the name of the Child", async () => {
    const { deps } = setup();
    const result = await lessonsExport(deps, { childId: CHILD1 });
    expect(result).toMatchObject({ childId: CHILD1, child: "Child One", timezone: "UTC" });
    expect(result.lessons[0]?.homeworkGiven).toHaveLength(0);
    expect(result.lessons[0]?.id).toBe(`${CHILD1}:2026-01-07:1`);
  });

  it("works without input", async () => {
    const { deps } = setup();
    expect((await lessonsExport(deps)).lessons).toHaveLength(1);
    expect((await upcomingExport(deps)).to).toBe("2026-03-08");
  });

  it("rejects a bad input", async () => {
    const { deps } = setup();
    await expect(upcomingExport(deps, [])).rejects.toThrow("Input must be an object.");
    await expect(upcomingExport(deps, { x: 1 })).rejects.toThrow("Unknown input key(s): x.");
    await expect(lessonsExport(deps, { days: 3 })).rejects.toThrow("Unknown input key(s): days.");
    await expect(upcomingExport(deps, { days: 61 })).rejects.toThrow("days must be an integer 0..60.");
    await expect(upcomingExport(deps, { childId: 5 })).rejects.toThrow("childId must be a text.");
    await expect(upcomingExport(deps, { childId: "other" })).rejects.toThrow("Unknown child: other.");
  });

  it("parseExportInput returns the defaults", () => {
    expect(parseExportInput({}, ["childId", "days"])).toEqual({ childId: undefined, days: 60 });
  });

  it("pickTarget needs childId when two Children have Librus", () => {
    const { config } = setup();
    const second = { ...config.accounts[0]!, id: "a2", child_id: "kid2" };
    config.children.push({ ...config.children[1]!, id: "kid2", has_librus: true });
    config.accounts.push(second);
    const { targets } = librusTargets(config);
    expect(() => pickTarget(targets, undefined)).toThrow("more than one Child");
    expect(pickTarget(targets, "kid2").account.id).toBe("a2");
    expect(() => pickTarget([], undefined)).toThrow("No Librus Account");
  });
});
