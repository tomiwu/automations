import { describe, expect, it } from "vitest";
import { changedWorkspaces, expandWorkspaceGlobs, fileList, type Workspace } from "./changed.ts";

const crap = { crap: "crap4ts" };
const workspaces: Workspace[] = [
  { name: "@x/shared", dir: "packages/shared", scripts: crap },
  { name: "@x/watch", dir: "packages/watch", scripts: crap },
  { name: "@x/watch-extra", dir: "packages/watch-extra", scripts: crap },
  { name: "@x/deploy", dir: "tools/deploy", scripts: {} },
];
const names = (selected: Workspace[]) => selected.map((workspace) => workspace.name);

describe("changedWorkspaces", () => {
  it("selects only the workspaces with a changed file", () => {
    expect(names(changedWorkspaces(["packages/watch/src/a.ts", "README.md"], workspaces))).toEqual(["@x/watch"]);
  });

  it("does not take a workspace whose name only starts the same", () => {
    expect(names(changedWorkspaces(["packages/watch-extra/src/a.ts"], workspaces))).toEqual(["@x/watch-extra"]);
  });

  it("skips a workspace without a crap script", () => {
    expect(names(changedWorkspaces(["tools/deploy/x.mjs"], workspaces))).toEqual([]);
  });

  it("selects all workspaces with crap when a shared root file changed", () => {
    expect(names(changedWorkspaces(["package-lock.json"], workspaces))).toEqual(["@x/shared", "@x/watch", "@x/watch-extra"]);
  });

  it("selects nothing for a change outside the workspaces", () => {
    expect(changedWorkspaces([".github/workflows/ci.yml", "docs/a.md"], workspaces)).toEqual([]);
  });
});

describe("expandWorkspaceGlobs", () => {
  it("expands dir/* in name order and keeps plain paths", () => {
    const listDir = (dir: string) => (dir === "packages" ? ["b", "a"] : []);
    expect(expandWorkspaceGlobs(["packages/*", "scripts/loop"], listDir)).toEqual(["packages/a", "packages/b", "scripts/loop"]);
  });
});

describe("fileList", () => {
  it("joins outputs without empty lines and repeats", () => {
    expect(fileList("a.ts\nb.ts\n", "", "b.ts\n c.ts \n")).toEqual(["a.ts", "b.ts", "c.ts"]);
  });
});
