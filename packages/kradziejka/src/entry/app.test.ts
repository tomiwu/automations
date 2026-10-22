import { describe, expect, it, vi } from "vitest";

const fakeSecret = "fake-secret-decrypt-detail";

vi.mock("@automations/shared/kody", () => ({ kodyAppBasePath: () => "" }));
vi.mock("./common.ts", () => ({
  adminDeps: async () => {
    throw new Error(fakeSecret);
  },
}));

describe("app entry", () => {
  it("returns a fixed text and a code when the app fails", async () => {
    const { default: app } = await import("./app.ts");
    const response = await app(new Request("https://example.test/"));
    const body = await response.text();
    expect(response.status).toBe(503);
    expect(body).toContain("app_failed");
    expect(body).not.toContain(fakeSecret);
  });
});
