// The private word list. The repository holds only salted hashes (`privacy/denylist.hashes.json`).
// The plain list stays in a git-ignored local file.
import { createHmac } from "node:crypto";
import { inflectedForms } from "./inflect.ts";
import { phrases, tokens } from "./normalize.ts";

export interface Denylist {
  version: 1;
  /** Random text that is part of the HMAC key. It is not secret. */
  salt: string;
  /** True when the hashes also need the secret `PRIVACY_PEPPER`. */
  peppered: boolean;
  /** Number of words of the longest entry. */
  maxWords: number;
  hashes: string[];
}

export function hashPhrase(salt: string, pepper: string, phrase: string): string {
  return createHmac("sha256", `${salt}:${pepper}`).update(phrase).digest("hex");
}

/** The entries of the plain list: one for each line, without empty lines and `#` comments. Each entry is its tokens. */
export function denylistEntries(plain: string): string[][] {
  return plain
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .map((line) => tokens(line))
    .filter((words) => words.length > 0);
}

const entryForms = (words: string[]) => (words.length === 1 ? inflectedForms(words[0] ?? "") : [words.join(" ")]);

export function buildDenylist(plain: string, salt: string, pepper: string): Denylist {
  const entries = denylistEntries(plain);
  const hashes = new Set(entries.flatMap(entryForms).map((form) => hashPhrase(salt, pepper, form)));
  return {
    version: 1,
    salt,
    peppered: pepper !== "",
    maxWords: Math.max(1, ...entries.map((words) => words.length)),
    hashes: [...hashes].sort(),
  };
}

export function parseDenylist(text: string | undefined): Denylist {
  if (text === undefined) return { version: 1, salt: "", peppered: false, maxWords: 1, hashes: [] };
  return JSON.parse(text) as Denylist;
}

/** Gives the function that says if a line contains a private word. It hashes every token and token sequence. */
export function denylistHit(list: Denylist, pepper: string): (line: string) => boolean {
  if (list.hashes.length === 0) return () => false;
  const hashes = new Set(list.hashes);
  const seen = new Map<string, boolean>();
  const isPrivate = (phrase: string) => {
    let hit = seen.get(phrase);
    if (hit === undefined) {
      hit = hashes.has(hashPhrase(list.salt, pepper, phrase));
      seen.set(phrase, hit);
    }
    return hit;
  };
  return (line) => phrases(tokens(line), list.maxWords).some(isPrivate);
}
