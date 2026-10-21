import type { Runtime } from "@automations/shared";
import { createActiveNowSource } from "./activenow-source.ts";
import { createEduskySource } from "./edusky-source.ts";
import { createMondoSource } from "./mondo-source.ts";
import type { ActivityTarget, SessionSource } from "./targets.ts";

/** Makes the source of one Account. The tests replace this function. */
export type CreateSource = (target: ActivityTarget, timezone: string) => SessionSource;

export function createSource(runtime: Runtime): CreateSource {
  return (target, timezone) => {
    switch (target.account.service) {
      case "activenow":
        return createActiveNowSource(runtime, target, timezone);
      case "mondo":
        return createMondoSource(runtime, target, timezone);
      default:
        return createEduskySource(runtime, target, timezone);
    }
  };
}
