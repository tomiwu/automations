import { eventsExport } from "../exports.ts";
import { entryDeps } from "./common.ts";

/** Read-only: the stored content of the Items of one Child. It reads Supabase only. */
export default async function events(input: unknown = {}) {
  return eventsExport(await entryDeps(), input);
}
