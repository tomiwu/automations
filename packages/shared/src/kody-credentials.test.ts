import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const packagesDir = new URL("../../", import.meta.url).pathname;
const sharedSrc = join(packagesDir, "shared", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "fixtures" ? [] : sourceFiles(path);
    return /\.(ts|mts|js|mjs)$/.test(name) && !/\.test\.|test-fixtures/.test(name) ? [path] : [];
  });
}

/** Secret names a source text uses: `secretName: "NAME"` and the `{{secret:NAME}}` placeholder (not the NAME example). */
export function usedSecrets(text: string): string[] {
  const names = [...text.matchAll(/secretName:\s*"([A-Z0-9_]+)"/g), ...text.matchAll(/\{\{secret:([A-Z0-9_]+)\}\}/g)].map((m) => m[1] ?? "");
  return [...new Set(names.filter((name) => name !== "NAME"))].sort();
}

const kodyPackages = readdirSync(packagesDir).filter((name) => {
  try {
    return Boolean(JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8")).kody);
  } catch {
    return false;
  }
});

describe("kody.credentials", () => {
  it("finds the deployed packages", () => {
    expect(kodyPackages).toEqual(expect.arrayContaining(["activities-watch", "librus-watch", "payments-watch"]));
  });

  it.each(kodyPackages)("%s declares every secret it uses, with a description (Kody publish gate)", (name) => {
    const manifest = JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8"));
    const declared: Record<string, { description?: string }> = manifest.kody.credentials ?? {};
    const files = [...sourceFiles(join(packagesDir, name, "src")), ...sourceFiles(sharedSrc)];
    const used = usedSecrets(files.map((file) => readFileSync(file, "utf8")).join("\n"));
    expect(used.length).toBeGreaterThan(0);
    for (const secret of used) {
      expect(declared[secret]?.description?.length ?? 0, `${name}: ${secret}`).toBeGreaterThan(30);
    }
  });

  it("reads secretName and placeholders, not the NAME example", () => {
    expect(usedSecrets('send({ secretName: "TELEGRAM_BOT_TOKEN" }); "{{secret:SUPABASE_KEY}}" `{{secret:NAME}}`')).toEqual([
      "SUPABASE_KEY",
      "TELEGRAM_BOT_TOKEN",
    ]);
  });
});
