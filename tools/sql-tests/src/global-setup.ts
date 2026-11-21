import { skipNotice } from "./skip-notice.js";

/** Vitest global setup: prints the skip notice one time for the run. */
export default function setup(): void {
  skipNotice(process.env).forEach((line) => console.log(line));
}
