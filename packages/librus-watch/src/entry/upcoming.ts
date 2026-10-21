import { upcomingExport } from "../exports.ts";
import { entryDeps } from "./common.ts";

/** Read-only: upcoming homework and tests of one Child. Input: `{ childId?: string, days?: number }`. */
export default async function upcoming(input: unknown = {}) {
  return upcomingExport(await entryDeps(), input);
}
