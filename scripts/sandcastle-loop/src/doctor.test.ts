import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const doctor = join(dirname(fileURLToPath(import.meta.url)), "..", "doctor.sh");
const FAKE_TOKEN = "gho_FAKE0123456789abcdefFAKE";
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function executable(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    spawnSync("chmod", ["-R", "u+rwx", dir]);
    rmSync(dir, { recursive: true, force: true });
  }
});

// A fake box: stub commands on PATH, a repo root with node_modules, a HOME and a /tmp with mode 1777.
// The fake podman runs the container part of the script on the host.
function fakeBox(options: { omit?: string[] } = {}) {
  const stub = tempDir("doctor-stub-");
  const root = tempDir("doctor-root-");
  const home = tempDir("doctor-home-");
  const tmp = tempDir("doctor-tmp-");
  chmodSync(tmp, 0o1777);
  mkdirSync(join(root, "node_modules", "@ai-hero", "sandcastle"), { recursive: true });
  const commands: Record<string, string> = {
    podman: `case "$1" in
  info) exit \${PODMAN_INFO_RC:-0} ;;
  image) exit \${PODMAN_IMAGE_RC:-0} ;;
  run) exec bash -s container ;;
esac
exit 1`,
    gh: `echo "token: ${FAKE_TOKEN}"; case "$1" in auth) exit \${GH_AUTH_RC:-0} ;; repo) exit \${GH_REPO_RC:-0} ;; *) echo "gh version 0" ;; esac`,
    claude: "echo 1.0.0",
    agent: "echo 1.0.0",
    node: "echo v22.0.0",
    git: "echo git version 2.0.0",
  };
  for (const [name, body] of Object.entries(commands)) {
    if (!options.omit?.includes(name)) executable(join(stub, name), body);
  }
  const env = {
    PATH: `${stub}:/usr/bin:/bin`,
    HOME: home,
    LOOP_ROOT: root,
    DOCTOR_TMP: tmp,
    LOOP_IMAGE: "sandcastle:example",
    LOOP_REPO: "example-owner/example-repo",
    LOOP_MODELS: "claude:model-a,cursor:model-b",
    XDG_RUNTIME_DIR: tmp,
  };
  return { stub, root, home, tmp, env };
}

function run(env: Record<string, string>, ...args: string[]) {
  const r = spawnSync("bash", [doctor, ...args], { env, encoding: "utf8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

describe("doctor.sh", () => {
  it("passes when all checks pass, and prints no token", () => {
    const { env } = fakeBox();
    const r = run(env);
    expect(r.out).not.toContain("DOCTOR FAIL");
    expect(r.status).toBe(0);
    expect(r.out).toContain("doctor ok: container");
    expect(r.out).not.toContain(FAKE_TOKEN);
  });

  const failures: [string, (box: ReturnType<typeof fakeBox>) => Record<string, string>, string][] = [
    ["missing node_modules", (b) => ({ ...b.env, LOOP_ROOT: b.home }), "DOCTOR FAIL: host node_modules/@ai-hero/sandcastle -> fix:"],
    ["podman info", (b) => ({ ...b.env, PODMAN_INFO_RC: "1" }), "DOCTOR FAIL: podman info"],
    ["missing image", (b) => ({ ...b.env, PODMAN_IMAGE_RC: "1" }), "DOCTOR FAIL: podman image exists sandcastle:example -> fix: scripts/sandcastle-loop/build-image.sh"],
    ["gh auth", (b) => ({ ...b.env, GH_AUTH_RC: "1" }), "DOCTOR FAIL: gh auth status -> fix:"],
    ["gh repo access", (b) => ({ ...b.env, GH_REPO_RC: "1" }), "DOCTOR FAIL: gh repo view example-owner/example-repo"],
    ["/tmp mode", (b) => (chmodSync(b.tmp, 0o755), b.env), "mode 1777 -> fix: install -d -m 1777 /tmp"],
    ["HOME not writable", (b) => (chmodSync(b.home, 0o500), b.env), "writable -> fix: chown -R agent:agent /home/agent"],
    ["extra repo hook", (b) => ({ ...b.env, LOOP_DOCTOR_EXTRA: "exit 3" }), "DOCTOR FAIL: LOOP_DOCTOR_EXTRA (exit 3)"],
  ];

  for (const [name, change, line] of failures) {
    it(`fails with a named line: ${name}`, () => {
      const box = fakeBox();
      const r = run(change(box));
      expect(r.status).not.toBe(0);
      expect(r.out).toContain(line);
      expect(r.out).not.toContain(FAKE_TOKEN);
    });
  }

  it("fails when the agent CLI of a model is missing", () => {
    const { env } = fakeBox({ omit: ["agent"] });
    const r = run(env);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain("DOCTOR FAIL: agent CLI agent --version");
    expect(run({ ...env, LOOP_MODELS: "claude:model-a" }).status).toBe(0);
  });

  it("runs only the host part or only the container part", () => {
    const box = fakeBox();
    chmodSync(box.tmp, 0o755);
    expect(run(box.env, "host").status).toBe(0);
    expect(run(box.env, "container").status).not.toBe(0);
    expect(run(box.env, "bad").status).toBe(2);
  });

  it("skips the container part without an image", () => {
    const box = fakeBox();
    chmodSync(box.tmp, 0o755);
    const r = run({ ...box.env, LOOP_IMAGE: "" });
    expect(r.status).toBe(0);
    expect(r.out).toContain("skip the container checks");
  });
});
