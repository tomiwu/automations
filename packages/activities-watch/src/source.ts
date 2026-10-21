import type { Runtime } from "@automations/shared";
import { createActiveNowSource } from "./activenow-source.ts";
import { createEduskySource } from "./edusky-source.ts";
import type { ActivityTarget, SessionSource } from "./targets.ts";

/** Makes the source of one Account. The tests replace this function. */
export type CreateSource = (target: ActivityTarget, timezone: string) => SessionSource;

export function createSource(runtime: Runtime): CreateSource {
  return (target, timezone) =>
    target.account.service === "activenow"
      ? createActiveNowSource(runtime, target, timezone)
      : createEduskySource(runtime, target, timezone);
}
