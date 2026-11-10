import { describe, expect, it } from "vitest";
import { preflight } from "./preflight.ts";

describe("preflight", () => {
  it("starts no agent when the doctor fails", () => {
    const logs: string[] = [];
    let agentStarted = false;
    if (preflight(() => 1, false, (m) => logs.push(m))) agentStarted = true;
    expect(agentStarted).toBe(false);
    expect(logs).toEqual(["DOCTOR FAIL (exit 1). No agent starts."]);
  });

  it("passes when the doctor passes or the start script ran it already", () => {
    let runs = 0;
    expect(preflight(() => (runs++, 0), false, () => {})).toBe(true);
    expect(preflight(() => (runs++, 1), true, () => {})).toBe(true);
    expect(runs).toBe(1);
  });
});
