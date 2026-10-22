#!/usr/bin/env node
// Builds a self-contained Kody package tree from one workspace package.
// Kody resolves npm dependencies from the public registry, so the private
// workspace packages (@automations/*) are copied into `vendor/` and their
// imports are rewritten to relative paths. Test files are left out.
//
// Usage: node tools/kody-stage/stage.mjs <package-dir> <out-dir>
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const CHEERIO_PINS = { entities: "4.5.0", htmlparser2: "9.1.0", parse5: "7.1.2" };
const root = resolve(dirname(new URL(import.meta.url).pathname), "../..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function workspacePackages() {
  const map = new Map();
  for (const name of readdirSync(join(root, "packages"))) {
    const dir = join(root, "packages", name);
    if (!existsSync(join(dir, "package.json"))) continue;
    map.set(readJson(join(dir, "package.json")).name, dir);
  }
  return map;
}

function isSkipped(path) {
  return /\.test\.ts$/.test(path) || /test-fixtures\.ts$/.test(path) || /(^|\/)(node_modules|coverage)(\/|$)/.test(path);
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (isSkipped(p)) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** Collects the @automations/* packages that `pkgDir` needs, transitively. */
function collectDeps(pkgDir, all, seen = new Map()) {
  const deps = readJson(join(pkgDir, "package.json")).dependencies ?? {};
  for (const name of Object.keys(deps)) {
    const dir = all.get(name);
    if (!dir || seen.has(name)) continue;
    seen.set(name, dir);
    collectDeps(dir, all, seen);
  }
  return seen;
}

function rewriteImports(file, outDir, specifiers, srcOf, workspaceNames) {
  let src = readFileSync(file, "utf8");
  src = src.replace(/(from\s+|import\s*\(\s*|import\s+)(["'])([^"']+)\2/g, (m, pre, q, spec) => {
    const pkgName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    if (!workspaceNames.has(pkgName)) return m;
    const target = specifiers.get(spec);
    if (!target) throw new Error(`${relative(outDir, file)}: no export for ${spec}`);
    let rel = relative(dirname(file), join(outDir, target)).split(sep).join("/");
    if (!rel.startsWith(".")) rel = "./" + rel;
    return `${pre}${q}${rel}${q}`;
  });
  // Triple-slash references point into other workspace packages; point them at the vendored copy.
  src = src.replace(/(\/\/\/\s*<reference\s+path=)(["'])([^"']+)\2/g, (m, pre, q, ref) => {
    const original = resolve(dirname(srcOf.get(file)), ref);
    for (const [fromDir, toDir] of srcOf.dirs) {
      if (original.startsWith(fromDir + sep)) {
        let rel = relative(dirname(file), join(toDir, relative(fromDir, original))).split(sep).join("/");
        if (!rel.startsWith(".")) rel = "./" + rel;
        return `${pre}${q}${rel}${q}`;
      }
    }
    return m;
  });
  writeFileSync(file, src);
}

function stage(pkgArg, outArg) {
  const pkgDir = resolve(pkgArg);
  const outDir = resolve(outArg);
  const all = workspacePackages();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const srcOf = new Map();
  srcOf.dirs = [];
  const copy = (from, to) => {
    srcOf.dirs.push([resolve(from, ".."), resolve(to, "..")]);
    for (const f of walk(from)) {
      const dest = join(to, relative(from, f));
      srcOf.set(dest, f);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(f, dest);
    }
  };
  copy(join(pkgDir, "src"), join(outDir, "src"));
  for (const doc of ["README.md", "AGENTS.md"]) {
    if (existsSync(join(pkgDir, doc))) cpSync(join(pkgDir, doc), join(outDir, doc));
  }
  // The staged tree stands alone, so the base tsconfig is inlined. Kody type-checks without the
  // types of npm packages (cheerio callbacks become implicit any); CI runs the strict check.
  const base = readJson(join(root, "tsconfig.base.json"));
  writeFileSync(
    join(outDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { ...(base.compilerOptions ?? {}), types: [], noImplicitAny: false }, include: ["src", "vendor"] }, null, 2) + "\n",
  );

  const specifiers = new Map();
  const deps = collectDeps(pkgDir, all);
  const npmDeps = { ...(readJson(join(pkgDir, "package.json")).dependencies ?? {}) };
  for (const [name, dir] of deps) {
    const leaf = name.split("/").pop();
    copy(join(dir, "src"), join(outDir, "vendor", leaf, "src"));
    const manifest = readJson(join(dir, "package.json"));
    const exportsMap = typeof manifest.exports === "string" ? { ".": manifest.exports } : manifest.exports;
    for (const [sub, target] of Object.entries(exportsMap)) {
      const spec = sub === "." ? name : `${name}/${sub.replace(/^\.\//, "")}`;
      specifiers.set(spec, join("vendor", leaf, target.replace(/^\.\//, "")));
    }
    for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
      if (!all.has(dep)) npmDeps[dep] ??= range;
    }
  }
  for (const name of Object.keys(npmDeps)) if (all.has(name)) delete npmDeps[name];

  for (const f of walk(outDir)) if (f.endsWith(".ts")) rewriteImports(f, outDir, specifiers, srcOf, new Set(all.keys()));

  const manifest = readJson(join(pkgDir, "package.json"));
  // Kody's bundler picks incompatible versions of cheerio's parser stack unless they are pinned.
  if (npmDeps.cheerio) {
    Object.assign(npmDeps, CHEERIO_PINS);
    manifest.overrides = { ...(manifest.overrides ?? {}), ...CHEERIO_PINS };
  }
  manifest.dependencies = npmDeps;
  // kody.dependencies must list every static `kody:@owner/name` import.
  const kodyDeps = {};
  for (const f of walk(outDir)) {
    if (!f.endsWith(".ts") || f.endsWith(".d.ts")) continue;
    for (const m of readFileSync(f, "utf8").matchAll(/["']kody:(@[^/"']+\/[^/"']+)/g)) kodyDeps[m[1]] = "*";
  }
  manifest.kody = { ...manifest.kody, dependencies: { ...(manifest.kody?.dependencies ?? {}), ...kodyDeps } };
  delete manifest.scripts;
  delete manifest.devDependencies;
  writeFileSync(join(outDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

  // Leftover workspace imports would fail on Kody; stop here instead.
  for (const f of walk(outDir)) {
    const text = f.endsWith(".ts") ? readFileSync(f, "utf8") : "";
    if ([...all.keys()].some((n) => text.includes(`"${n}"`) || text.includes(`"${n}/`))) {
      throw new Error(`${relative(outDir, f)} still imports a workspace package`);
    }
  }
  console.log(`Staged ${manifest.name} in ${relative(root, outDir) || outDir}`);
}

const [pkgArg, outArg] = process.argv.slice(2);
if (!pkgArg || !outArg) {
  console.error("Usage: node tools/kody-stage/stage.mjs <package-dir> <out-dir>");
  process.exit(2);
}
stage(pkgArg, outArg);
