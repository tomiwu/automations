import { sessionsExport } from "../exports.ts";
import { entryDeps } from "./common.ts";

/** Read-only: every Session of every Child for the next 14 days. It takes no input. */
export default async function sessions(input: unknown = {}) {
  return sessionsExport(await entryDeps(), input);
}
