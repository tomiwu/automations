import { runPurge } from "../purge.ts";
import { entryDeps } from "./common.ts";

/** Runs the daily purge of delivered Outbox entries. It takes no input. */
export default async function purge(input: unknown = {}): Promise<{ ok: true; removed: number }> {
  if (typeof input !== "object" || input === null || Object.keys(input).length > 0) {
    throw new Error("This export takes no input.");
  }
  const { runtime, storage } = await entryDeps();
  return { ok: true, removed: await runPurge({ runtime, storage }) };
}
