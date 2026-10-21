import { childrenExport } from "../exports.ts";
import { entryDeps } from "./common.ts";

/** Read-only: the id, name and calendar_id of every Child. It takes no input. */
export default async function children(input: unknown = {}) {
  return childrenExport(await entryDeps(), input);
}
