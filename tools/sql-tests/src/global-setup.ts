import { skipNotice } from "./skip-notice.js";

export default function setup(): void {
  skipNotice(process.env).forEach((line) => console.log(line));
}
