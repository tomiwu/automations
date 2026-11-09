import { storedLessonsExport } from "../stored-lessons.ts";
import { entryDeps } from "./common.ts";

/** Read-only: the stored Lessons and homework of one Child. It reads Supabase only. */
export default async function storedLessons(input: unknown = {}) {
  return storedLessonsExport(await entryDeps(), input);
}
