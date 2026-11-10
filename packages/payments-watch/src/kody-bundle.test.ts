import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  exports: Record<string, string>;
  kody: { jobs: Record<string, { entry: string }>; app?: { entry: string } };
};

const entries = [
  ...new Set([
    ...Object.values(pkg.exports),
    ...Object.values(pkg.kody.jobs).map((job) => job.entry),
    ...(pkg.kody.app ? [pkg.kody.app.entry] : []),
  ]),
];

const stubKody: Plugin = {
  name: "stub-kody",
  setup(b) {
    b.onResolve({ filter: /^kody:/ }, (args) => ({ path: args.path, namespace: "kody-stub" }));
    b.onLoad({ filter: /.*/, namespace: "kody-stub" }, () => ({ contents: "module.exports = new Proxy({}, { get: () => () => undefined });", loader: "js" }));
  },
};

// The Node build of cheerio bundles undici (lazy requires of Node built-ins that do not run at load time).
// The parsers use only `load`, so the test bundles the browser build of cheerio to check the rest of the code.
const cheerioBrowser = createRequire(import.meta.url).resolve("cheerio/package.json").replace(/package\.json$/, "dist/browser/index.js");

const outDir = mkdtempSync(join(tmpdir(), "pw-bundle-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

describe("Kody ESM bundle", () => {
  it.each(entries)("%s has no CommonJS require of a Node built-in and loads in ESM", async (entry) => {
    const outfile = join(outDir, `${entry.replace(/[^a-z0-9]+/gi, "_")}.mjs`);
    await build({
      entryPoints: [join(root, entry)],
      bundle: true,
      format: "esm",
      platform: "node",
      outfile,
      alias: { cheerio: cheerioBrowser },
      plugins: [stubKody],
      logLevel: "silent",
    });
    const text = readFileSync(outfile, "utf8");
    const required = [...text.matchAll(/__require\("([^"]+)"\)/g)].map((m) => m[1] as string);
    expect(required.filter((name) => builtins.has(name))).toEqual([]);
    await expect(import(pathToFileURL(outfile).href)).resolves.toBeDefined();
  });
});
