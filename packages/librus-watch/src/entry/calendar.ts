import { calendarExport } from "../exports.ts";
import { entryDeps } from "./common.ts";

/**
 * Read-only: the Lessons of the next 14 days with the homework and tests of the same days, in one read with one
 * Librus login. Input: `{ childId?: string }`.
 */
export default async function calendar(input: unknown = {}) {
  return calendarExport(await entryDeps(), input);
}
