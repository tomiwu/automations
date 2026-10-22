import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("kody:runtime", () => ({
  packageStorage: () => ({
    get: async (key: string) => store.get(key),
    set: async (key: string, value: string) => void store.set(key, value),
  }),
}));

import {
  KODY_RUNTIME_EXPORTS,
  createKodyRuntime,
  kodyRuntime,
  kodyStorage,
  loadDeploymentConfig,
  parseDeploymentConfig,
  saveDeploymentConfig,
  secretPlaceholder,
  type KodyHost,
} from "./kody.ts";

const config = { supabaseUrl: "https://example.supabase.co", familyId: "00000000-0000-0000-0000-000000000001" };

function host(): KodyHost & { logs: unknown[][] } {
  const logs: unknown[][] = [];
  return { logs, fetch: async (input) => new Response(input), log: (...args) => void logs.push(args) };
}

describe("createKodyRuntime", () => {
  it("maps fetch and log to the host and gives secrets as placeholders", async () => {
    const kody = host();
    const runtime = createKodyRuntime(kody, () => new Date("2025-01-02T00:00:00Z"));
    await expect((await runtime.fetch("abc")).text()).resolves.toBe("abc");
    await expect(runtime.secret("SUPABASE_KEY")).resolves.toBe("{{secret:SUPABASE_KEY}}");
    expect(runtime.now().toISOString()).toBe("2025-01-02T00:00:00.000Z");
    runtime.log("error", "m");
    expect(kody.logs).toEqual([["error", "m"]]);
    expect(() => runtime.schedule({ cron: "* * * * *", timezone: "UTC" }, async () => undefined)).toThrow("kody.jobs");
  });

  it("rejects an invalid secret name", async () => {
    expect(() => secretPlaceholder("a}}b")).toThrow("Invalid secret name");
    await expect(createKodyRuntime(host()).secret("")).rejects.toThrow("Invalid secret name");
  });

  it("defaults to the real clock", () => {
    expect(createKodyRuntime(host()).now()).toBeInstanceOf(Date);
  });

  it("kodyRuntime uses placeholders", async () => {
    await expect(kodyRuntime.secret("X")).resolves.toBe("{{secret:X}}");
  });
});

describe("deployment config", () => {
  it("saves and loads through the package storage", async () => {
    store.clear();
    await expect(loadDeploymentConfig(kodyStorage())).rejects.toThrow("./configure");
    await expect(saveDeploymentConfig(kodyStorage(), { ...config, supabaseUrl: config.supabaseUrl + "/" })).resolves.toEqual(config);
    await expect(loadDeploymentConfig(kodyStorage())).resolves.toEqual(config);
  });

  it("accepts an object that the storage returns already parsed", async () => {
    await expect(loadDeploymentConfig({ get: async () => config, set: async () => undefined })).resolves.toEqual(config);
  });

  it("rejects bad input", () => {
    expect(() => parseDeploymentConfig(null)).toThrow("object");
    expect(() => parseDeploymentConfig([])).toThrow("object");
    expect(() => parseDeploymentConfig({ ...config, extra: 1 })).toThrow("Unknown config keys: extra");
    expect(() => parseDeploymentConfig({ ...config, supabaseUrl: "http://x" })).toThrow("supabaseUrl");
    expect(() => parseDeploymentConfig({ ...config, supabaseUrl: "https://x/rest/v1" })).toThrow("supabaseUrl");
    expect(() => parseDeploymentConfig({ ...config, familyId: "a b" })).toThrow("familyId");
    expect(() => parseDeploymentConfig({ supabaseUrl: config.supabaseUrl })).toThrow("familyId");
  });
});

describe("kody:runtime imports", () => {
  const root = resolve(__dirname, "../../..");
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === "node_modules" || name === "coverage") return [];
      return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
    });

  it("use only names that kody:runtime really exports", () => {
    const allowed = new Set<string>(KODY_RUNTIME_EXPORTS);
    const used: string[] = [];
    for (const file of files(join(root, "packages"))) {
      if (file.endsWith(".test.ts")) continue;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/import\s+([^;]*?)\s+from\s+["']kody:runtime["']/g)) {
        const clause = match[1] ?? "";
        if (/^\*\s+as\s/.test(clause)) used.push(`${file}: namespace import`);
        for (const name of clause.match(/\{([^}]*)\}/)?.[1]?.split(",") ?? []) {
          const imported = name.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0] ?? "";
          if (imported && !allowed.has(imported)) used.push(`${file}: ${imported}`);
        }
      }
      for (const match of source.matchAll(/export\s+(?:const|function)\s+(\w+)/g)) {
        if (file.endsWith("kody-runtime.d.ts") && !allowed.has(match[1] ?? "")) used.push(`${file}: declares ${match[1]}`);
      }
    }
    expect(used).toEqual([]);
  });
});
