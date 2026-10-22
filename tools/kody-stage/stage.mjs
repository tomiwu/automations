#!/usr/bin/env node
// Builds a self-contained Kody package tree from one workspace package.
// Kody resolves npm dependencies from the public registry, so the private
// workspace packages (@automations/*) are copied into `vendor/` and their
// imports are rewritten to relative paths. Test files are left out.
//
// Usage: node tools/kody-stage/stage.mjs <package-dir> <out-dir>
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const WORKSPACE_SCOPE = "@automations/";
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
    if (!name.startsWith(WORKSPACE_SCOPE) || seen.has(name)) continue;
    const dir = all.get(name);
    if (!dir) throw new Error(`Unknown workspace package ${name}`);
    seen.set(name, dir);
    collectDeps(dir, all, seen);
  }
  return seen;
}

function rewriteImports(file, outDir, specifiers) {
  let src = readFileSync(file, "utf8");
  src = src.replace(/(from\s+|import\s*\(\s*|import\s+)(["'])(@automations\/[^"']+)\2/g, (m, pre, q, spec) => {
    const target = specifiers.get(spec);
    if (!target) throw new Error(`${relative(outDir, file)}: no export for ${spec}`);
    let rel = relative(dirname(file), join(outDir, target)).split(sep).join("/");
    if (!rel.startsWith(".")) rel = "./" + rel;
    return `${pre}${q}${rel}${q}`;
  });
  writeFileSync(file, src);
}

function stage(pkgArg, outArg) {
  const pkgDir = resolve(pkgArg);
  const outDir = resolve(outArg);
  const all = workspacePackages();
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const copy = (from, to) => {
    for (const f of walk(from)) {
      const dest = join(to, relative(from, f));
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(f, dest);
    }
  };
  copy(join(pkgDir, "src"), join(outDir, "src"));
  if (existsSync(join(pkgDir, "README.md"))) cpSync(join(pkgDir, "README.md"), join(outDir, "README.md"));
  // The staged tree stands alone, so the base tsconfig is inlined.
  const base = readJson(join(root, "tsconfig.base.json"));
  writeFileSync(
    join(outDir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: base.compilerOptions ?? {}, include: ["src", "vendor"] }, null, 2) + "\n",
  );

  const specifiers = new Map();
  const deps = collectDeps(pkgDir, all);
  const npmDeps = { ...(readJson(join(pkgDir, "package.json")).dependencies ?? {}) };
  for (const [name, dir] of deps) {
    const leaf = name.slice(WORKSPACE_SCOPE.length);
    copy(join(dir, "src"), join(outDir, "vendor", leaf, "src"));
    const manifest = readJson(join(dir, "package.json"));
    const exportsMap = typeof manifest.exports === "string" ? { ".": manifest.exports } : manifest.exports;
    for (const [sub, target] of Object.entries(exportsMap)) {
      const spec = sub === "." ? name : `${name}/${sub.replace(/^\.\//, "")}`;
      specifiers.set(spec, join("vendor", leaf, target.replace(/^\.\//, "")));
    }
    for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
      if (!dep.startsWith(WORKSPACE_SCOPE)) npmDeps[dep] ??= range;
    }
  }
  for (const name of Object.keys(npmDeps)) if (name.startsWith(WORKSPACE_SCOPE)) delete npmDeps[name];

  for (const f of walk(outDir)) if (f.endsWith(".ts")) rewriteImports(f, outDir, specifiers);

  const manifest = readJson(join(pkgDir, "package.json"));
  manifest.dependencies = npmDeps;
  delete manifest.scripts;
  delete manifest.devDependencies;
  writeFileSync(join(outDir, "package.json"), JSON.stringify(manifest, null, 2) + "\n");

  // Leftover workspace imports would fail on Kody; stop here instead.
  for (const f of walk(outDir)) {
    if (f.endsWith(".ts") && /["']@automations\//.test(readFileSync(f, "utf8"))) {
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
