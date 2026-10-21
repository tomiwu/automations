declare module "kody:runtime" {
  import type { KodyHost } from "./kody.ts";
  export const fetch: KodyHost["fetch"];
  export const getSecret: KodyHost["getSecret"];
  export const log: KodyHost["log"];
  export const schedule: KodyHost["schedule"];
}
