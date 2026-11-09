import { storedSessionsExport } from "../stored-sessions.ts";
import { entryDeps } from "./common.ts";

/** Read-only: the stored Sessions of the Children. It reads Supabase only. */
export default async function storedSessions(input: unknown = {}) {
  return storedSessionsExport(await entryDeps(), input);
}
