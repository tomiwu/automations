import { afterSchoolExport } from "../exports.ts";
import { entryDeps } from "./common.ts";

/** Read-only: the after-school section of one Child. Input: `{ childId, day, language? }`, `day` as `YYYY-MM-DD`. */
export default async function afterSchool(input: unknown) {
  return afterSchoolExport(await entryDeps(), input);
}
