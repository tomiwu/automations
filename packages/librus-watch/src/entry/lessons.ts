import { lessonsExport } from "../exports.ts";
import { entryDeps } from "./common.ts";

/** Read-only: the Lessons of one Child for the next 14 days. Input: `{ childId?: string }`. */
export default async function lessons(input: unknown = {}) {
  return lessonsExport(await entryDeps(), input);
}
