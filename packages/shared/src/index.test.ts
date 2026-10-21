import { describe, expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.ts";

describe("shared", () => {
  it("exports the package name", () => {
    expect(PACKAGE_NAME).toBe("@automations/shared");
  });
});
