import { describe, expect, it } from "vitest";
import { buildDecisionRequest, mapRoute, readChoice, routeCriteria, type MapRouteInput } from "./routing.ts";

const bots = [
  { slug: "hub", description: "Help to choose a bot." },
  { slug: "grades", description: "Questions about grades." },
];

function input(patch: Partial<MapRouteInput> = {}): MapRouteInput {
  return {
    answer: { choice: "grades", confidence: 0.9 },
    criteria: routeCriteria(bots),
    lastBot: "grades",
    routable: new Set(["hub", "grades"]),
    threshold: 0.6,
    ...patch,
  };
}

describe("routing decision mapping", () => {
  it("builds one choice question from the active bots plus create_new_bot and hub", () => {
    const request = buildDecisionRequest(
      { currentText: "What is the grade?", hasPhoto: false, recent: [{ from: "person", text: "Hi" }], lastBot: "grades" },
      bots,
    );
    expect(request.questions.route.type).toBe("choice");
    expect(request.questions.route.instructions).toContain("last bot");
    expect(Object.keys(request.questions.route.criteria).sort()).toEqual(["create_new_bot", "grades", "hub"]);
    expect(request.state.last_bot).toBe("grades");
    expect(request.state.current.text).toBe("What is the grade?");
    expect(request.state.recent).toEqual([{ from: "person", text: "Hi" }]);
  });

  it("adds a hub criterion when the registry has no hub row", () => {
    expect(routeCriteria([{ slug: "grades", description: "Grades" }]).hub).toContain("Hub");
    expect(routeCriteria([{ slug: "create_new_bot", description: "skip" }]).create_new_bot).toContain("new bot");
  });

  it("keeps a confident choice and sends create_new_bot to the hub", () => {
    expect(mapRoute(input())).toEqual({ slug: "grades", intent: "message", reason: "choice" });
    expect(mapRoute(input({ answer: { choice: "create_new_bot", confidence: 0.95 } }))).toEqual({
      slug: "hub",
      intent: "create_new_bot",
      reason: "create-new-bot",
    });
    expect(mapRoute(input({ answer: { choice: "hub", confidence: 0.8 } })).slug).toBe("hub");
  });

  it("stays with the last bot when confidence is low, and uses the hub when there is no last bot", () => {
    const low = { choice: "grades", confidence: 0.2 };
    expect(mapRoute(input({ answer: low })).reason).toBe("low-confidence");
    expect(mapRoute(input({ answer: low, lastBot: null }))).toEqual({ slug: "hub", intent: "message", reason: "low-confidence-hub" });
    expect(mapRoute(input({ answer: null }))).toMatchObject({ slug: "grades", reason: "low-confidence" });
    expect(mapRoute(input({ answer: { choice: "missing", confidence: 0.99 } })).reason).toBe("low-confidence");
  });

  it("does not stay with a bot that is not routable", () => {
    const closed = input({ answer: { choice: "grades", confidence: 0.2 }, routable: new Set(["hub"]) });
    expect(closed && mapRoute(closed)).toEqual({ slug: "hub", intent: "message", reason: "low-confidence-hub" });
    expect(mapRoute(input({ answer: { choice: "grades", confidence: 0.99 }, routable: new Set(["hub"]) })).reason).toBe("not-routable-hub");
  });

  it("reads a Jev choice and ignores a bad body", () => {
    expect(readChoice({ answers: { route: { type: "choice", choice: "hub", confidence: 0.5 } } })).toEqual({ choice: "hub", confidence: 0.5 });
    expect(readChoice(null)).toBeNull();
    expect(readChoice({ answers: null })).toBeNull();
    expect(readChoice({ answers: { route: { choice: "", confidence: 1 } } })).toBeNull();
    expect(readChoice({ answers: { route: { choice: "hub", confidence: "high" } } })).toBeNull();
    expect(readChoice([])).toBeNull();
  });
});
