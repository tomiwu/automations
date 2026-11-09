import { streamHistoryExport } from "../stream-history.ts";
import { entryDeps } from "./common.ts";

/** Read-only: the Journal events of one stream. It reads Supabase only. */
export default async function streamHistory(input: unknown = {}) {
  return streamHistoryExport(await entryDeps(), input);
}
