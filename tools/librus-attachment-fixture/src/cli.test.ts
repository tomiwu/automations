import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("attachment fixture cli", () => {
  it("prints the outbox and a sendDocument call", () => {
    const html = new URL("../../../packages/librus-watch/src/fixtures/message-with-attachment.html", import.meta.url).pathname;
    const pdf = new URL("../../../packages/librus-watch/src/fixtures/sample.pdf", import.meta.url).pathname;
    const run = spawnSync("npx", ["tsx", "tools/librus-attachment-fixture/src/cli.ts", "--fixture", html, "--file", pdf], {
      cwd: new URL("../../..", import.meta.url).pathname,
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    const out = `${run.stdout}${run.stderr}`;
    expect(out).toContain("sendDocument chat=1000001");
    expect(out).toContain("name=sample.pdf");
    expect(out).toContain("document 1000001");
  });
});