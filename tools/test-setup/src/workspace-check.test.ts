import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkWorkspaceResolution, findUp, isInside, OUTSIDE_MESSAGE } from "./workspace-check.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "ws-check-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  mkdirSync(join(root, "packages", "shared"), { recursive: true });
  mkdirSync(join(root, "packages", "watch"), { recursive: true });
  mkdirSync(join(root, "node_modules", "@automations"), { recursive: true });
  return root;
}

describe("checkWorkspaceResolution", () => {
  it("passes when the package resolves inside the checkout", () => {
    const root = checkout();
    symlinkSync(join(root, "packages", "shared"), join(root, "node_modules", "@automations", "shared"));
    expect(() => checkWorkspaceResolution(join(root, "packages", "watch"))).not.toThrow();
  });

  it("fails with one line when the package resolves to another checkout", () => {
    const root = checkout();
    const other = checkout();
    symlinkSync(join(other, "packages", "shared"), join(root, "node_modules", "@automations", "shared"));
    expect(() => checkWorkspaceResolution(join(root, "packages", "watch"))).toThrow(OUTSIDE_MESSAGE);
  });

  it("fails when the whole node_modules is a link to another checkout", () => {
    const root = checkout();
    const other = checkout();
    symlinkSync(join(other, "packages", "shared"), join(other, "node_modules", "@automations", "shared"));
    rmSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(join(other, "node_modules"), join(root, "node_modules"));
    expect(() => checkWorkspaceResolution(join(root, "packages", "watch"))).toThrow(OUTSIDE_MESSAGE);
  });

  it("does nothing outside a workspace or without the package", () => {
    const plain = mkdtempSync(join(tmpdir(), "ws-plain-"));
    dirs.push(plain);
    expect(() => checkWorkspaceResolution(plain)).not.toThrow();
    expect(() => checkWorkspaceResolution(join(checkout(), "packages", "watch"))).not.toThrow();
  });

  it("passes in this repository", () => {
    expect(() => checkWorkspaceResolution(process.cwd())).not.toThrow();
  });
});

describe("isInside and findUp", () => {
  it("compares paths without a prefix mistake", () => {
    expect(isInside("/a/b", "/a/b")).toBe(true);
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a")).toBe(false);
  });

  it("returns null when no directory up to / matches", () => {
    expect(findUp("/tmp", () => false)).toBeNull();
    expect(findUp("/tmp/x/y", (dir) => dir === "/tmp")).toBe("/tmp");
  });
});
