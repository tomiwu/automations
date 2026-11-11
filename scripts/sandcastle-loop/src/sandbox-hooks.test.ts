import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The Sandcastle setup of this repository (.sandcastle/) must install the git hooks of scripts/hooks
// in each sandbox, and its image must have the gitleaks of scripts/install-hooks.sh.
const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const read = (path: string): string => readFileSync(join(repo, path), "utf8");

function sandboxReadyCommands(): string[] {
  const block = /onSandboxReady:\s*\[([\s\S]*?)\]/.exec(read(".sandcastle/main.mts"));
  expect(block).not.toBeNull();
  return [...(block?.[1] ?? "").matchAll(/command:\s*"([^"]+)"/g)].map((match) => match[1] ?? "");
}

function pinned(text: string, pattern: RegExp): string | undefined {
  return pattern.exec(text)?.[1];
}

describe(".sandcastle/main.mts", () => {
  it("runs scripts/install-hooks.sh right after npm ci", () => {
    const commands = sandboxReadyCommands();
    const npmCi = commands.findIndex((command) => command.startsWith("npm ci"));
    expect(npmCi).toBeGreaterThanOrEqual(0);
    expect(commands[npmCi + 1]).toBe("bash scripts/install-hooks.sh");
  });
});

describe(".sandcastle/Containerfile", () => {
  it("pins the gitleaks version and sha256 of scripts/install-hooks.sh and checks the sha256", () => {
    const containerfile = read(".sandcastle/Containerfile");
    const installer = read("scripts/install-hooks.sh");
    expect(pinned(containerfile, /^ARG GITLEAKS_VERSION=(\S+)$/m)).toBe(pinned(installer, /^GITLEAKS_VERSION=(\S+)$/m));
    expect(pinned(containerfile, /^ARG GITLEAKS_SHA256=([0-9a-f]{64})$/m)).toBe(pinned(installer, /^SHA256_x64=([0-9a-f]{64})$/m));
    expect(containerfile).toContain("sha256sum -c -");
    expect(containerfile).toContain('rm -f "$f" gitleaks-checksums.txt');
  });
});
