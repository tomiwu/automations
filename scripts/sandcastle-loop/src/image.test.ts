import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { hermeticEnv, type Hermetic } from "./test-env.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "build-image.sh");
const containerfile = join(root, "Containerfile");
const dirs: string[] = [];

const boxes: Hermetic[] = [];

afterEach(() => {
  boxes.splice(0).forEach((box) => box.cleanup());
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A stub podman that writes its arguments to a file. It builds nothing. git is the real git.
function stubPodman(): { dir: string; env: Record<string, string>; args: () => string[] } {
  const box = hermeticEnv({}, { real: ["git"] });
  boxes.push(box);
  const out = join(box.stubDir, "args");
  box.stub("podman", `for a in "$@"; do echo "$a"; done > "${out}"\necho "STEP 1/20: FROM node"`);
  return { dir: box.stubDir, env: box.env, args: () => readFileSync(out, "utf8").trim().split("\n") };
}

const shortSha = (path: string) => execFileSync("git", ["hash-object", path], { encoding: "utf8" }).trim().slice(0, 7);

describe("build-image.sh", () => {
  it("builds with the tag sandcastle:<repo>-<short sha of the Containerfile> and prints only the tag", () => {
    const { env, args } = stubPodman();
    const r = spawnSync("bash", [script], {
      env: { ...env, LOOP_REPO: "example-owner/example-repo", LOOP_MODELS: "claude:model-a" },
      encoding: "utf8",
    });
    const tag = `sandcastle:example-repo-${shortSha(containerfile)}`;
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${tag}\n`);
    expect(r.stderr).toContain("STEP 1/20");
    const a = args();
    expect(a.slice(0, 5)).toEqual(["build", "-t", tag, "-f", containerfile]);
    expect(a).toContain("LOOP_MODELS=claude:model-a");
    expect(a.at(-1)).toBe(root);
  });

  it("takes the repo name from the origin URL, not from a worktree directory name", () => {
    const { env: stubEnv } = stubPodman();
    const work = mkdtempSync(join(tmpdir(), "loop-wt-"));
    const wt = join(work, "example-repo-170");
    mkdirSync(wt);
    spawnSync("git", ["init", "-q", wt]);
    spawnSync("git", ["-C", wt, "remote", "add", "origin", "git@github.com:example-owner/example-repo.git"]);
    const env = { ...stubEnv };
    const r = spawnSync("bash", [script], { cwd: wt, env, encoding: "utf8" });
    rmSync(work, { recursive: true, force: true });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(`sandcastle:example-repo-${shortSha(containerfile)}`);
  });

  it("uses the Containerfile, context and image name of another repository", () => {
    const { dir, env, args } = stubPodman();
    const own = join(dir, "Containerfile");
    writeFileSync(own, "FROM scratch\n");
    const r = spawnSync("bash", [script], {
      env: { ...env, LOOP_REPO: "o/other", LOOP_CONTAINERFILE: own, LOOP_IMAGE_NAME: "box", LOOP_BUILD_CONTEXT: "/ctx" },
      encoding: "utf8",
    });
    expect(r.stdout.trim()).toBe(`box:other-${shortSha(own)}`);
    expect(args().slice(3, 5)).toEqual(["-f", own]);
    expect(args().at(-1)).toBe("/ctx");
  });

  it("fails when the Containerfile does not exist", () => {
    const { dir, env } = stubPodman();
    const r = spawnSync("bash", [script], {
      env: { ...env, LOOP_REPO: "o/r", LOOP_CONTAINERFILE: join(dir, "missing") },
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not exist");
  });
});

describe("Containerfile", () => {
  const text = readFileSync(containerfile, "utf8");

  it("has the permission steps as the last root steps", () => {
    const lastRoot = text.lastIndexOf("USER root");
    const after = text.slice(lastRoot);
    expect(after).toContain("install -d -m 1777 /tmp");
    expect(after).toContain("chown -R $AGENT_UID:$AGENT_GID /home/agent");
    expect(after.indexOf("USER ${AGENT_UID}:${AGENT_GID}")).toBeGreaterThan(after.indexOf("chown -R $AGENT_UID:$AGENT_GID"));
  });

  it("sets apt to https, 5 retries and no SRV records before the first apt-get", () => {
    const firstApt = text.indexOf("apt-get update");
    const netStep = text.indexOf("Acquire::EnableSrvRecords");
    expect(text).toContain('Acquire::Retries "5";');
    expect(text).toContain('Acquire::EnableSrvRecords "false";');
    expect(text).toContain("s|http://deb.debian.org|https://deb.debian.org|g");
    expect(netStep).toBeGreaterThan(-1);
    expect(netStep).toBeLessThan(firstApt);
  });

  it("uses numeric ids for chown, because the group of the renamed user is still node", () => {
    expect(text).not.toMatch(/chown -R agent:agent/);
  });

  it("ends with a RUN of the container doctor as the agent user", () => {
    const runs = [...text.matchAll(/^RUN .*$/gm)].map((m) => m[0]);
    expect(runs.at(-1)).toContain("doctor.sh container");
    expect(text).toContain("COPY doctor.sh");
  });
});

describe("sandbox image CI workflow", () => {
  const workflow = readFileSync(join(root, "..", "..", ".github", "workflows", "sandbox-image.yml"), "utf8");

  it("runs on PRs that change the image files", () => {
    for (const path of ["scripts/sandcastle-loop/Containerfile", "scripts/sandcastle-loop/doctor.sh", "scripts/sandcastle-loop/build-image.sh"]) {
      expect(workflow).toContain(`- ${path}`);
    }
    expect(workflow).toMatch(/^\s+pull_request:/m);
    expect(workflow).toMatch(/^\s+schedule:/m);
  });

  it("builds this Containerfile with the doctor build arg and uses no secret", () => {
    expect(workflow).toContain("-f scripts/sandcastle-loop/Containerfile");
    expect(workflow).toContain("LOOP_MODELS=claude:default,cursor:default");
    expect(workflow).not.toMatch(/secrets\./);
    expect(workflow).not.toMatch(/docker push|podman push/);
  });
});

