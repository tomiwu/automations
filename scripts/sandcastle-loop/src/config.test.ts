import { describe, expect, it } from "vitest";
import { loadConfig, parseModels, repoNameOf } from "./config.ts";

describe("loadConfig", () => {
  it("uses the defaults", () => {
    const c = loadConfig({}, "/work/example-repo", "/prompts");
    expect(c.label).toBe("Sandcastle");
    expect(c.models).toEqual([
      { provider: "claude", model: "claude-sonnet-5-5" },
      { provider: "cursor", model: "composer-2.5" },
    ]);
    expect(c.logDir).toBe("/workspace/loops/example-repo");
    expect(c.checks).toContain("npm run crap");
    expect(c.sort).toEqual(["priority", "number"]);
    expect(c.repo).toBeUndefined();
    expect(c.image).toBeUndefined();
    expect(c.maxIterations).toBe(10);
    expect(c.promptDir).toBe("/prompts");
  });

  it("reads the environment", () => {
    const c = loadConfig({
      LOOP_REPO: "example-owner/example-repo", LOOP_LABEL: "Ralph", LOOP_MODELS: "cursor:composer-2.5",
      LOOP_LOG_DIR: "/tmp/logs", LOOP_CHECKS: "make check", LOOP_IMAGE: "example-image", LOOP_SORT: "-number",
      MAX_ITERATIONS: "2", SKIP_ISSUES: "4,5", LOOP_PROMPT_DIR: "/custom",
    }, "/work/other", "/prompts");
    expect(c).toMatchObject({
      repo: "example-owner/example-repo", repoName: "example-repo", label: "Ralph", logDir: "/tmp/logs",
      checks: "make check", image: "example-image", sort: ["-number"], maxIterations: 2, promptDir: "/custom",
      models: [{ provider: "cursor", model: "composer-2.5" }],
    });
    expect([...c.skip]).toEqual([4, 5]);
  });

  it("falls back for a bad number", () => {
    expect(loadConfig({ MAX_ITERATIONS: "many" }, "/w/r", "/p").maxIterations).toBe(10);
  });
});

describe("parseModels", () => {
  it("keeps colons in the model name", () => {
    expect(parseModels("claude:a:b")).toEqual([{ provider: "claude", model: "a:b" }]);
  });

  it("rejects bad entries", () => {
    expect(() => parseModels("gpt:x")).toThrow("Bad LOOP_MODELS entry");
    expect(() => parseModels("claude")).toThrow("Bad LOOP_MODELS entry");
    expect(() => parseModels(" , ")).toThrow("no model");
  });
});

describe("repoNameOf", () => {
  it("takes the last path part", () => {
    expect(repoNameOf("owner/name", "/x")).toBe("name");
    expect(repoNameOf(undefined, "/x/dir/")).toBe("dir");
    expect(repoNameOf(undefined, "/")).toBe("repo");
  });
});
