import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const LINK = /\]\(\s*(?:<([^>]*)>|([^)\s]+))[^)]*\)/g;
const NOT_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i;

export function relativeLinks(markdown: string): string[] {
  return [...markdown.replace(CODE, "").matchAll(LINK)]
    .map((match) => match[1] ?? match[2] ?? "")
    .filter((target) => !NOT_RELATIVE.test(target))
    .map((target) => target.split("#")[0] ?? "")
    .filter((target) => target !== "");
}

export function brokenLinks(file: string): string[] {
  return relativeLinks(readFileSync(file, "utf8"))
    .map((target) => decodeURIComponent(target))
    .filter((target) => !existsSync(resolve(dirname(file), target)));
}
