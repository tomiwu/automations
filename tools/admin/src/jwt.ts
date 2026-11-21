import { createHmac } from "node:crypto";

export const WATCHER_ROLE = "automations_watcher";
const TEN_YEARS_SECONDS = 10 * 365 * 24 * 3600;

const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url");

export function signWatcherKey(jwtSecret: string, nowSeconds: number): string {
  const header = encode({ alg: "HS256", typ: "JWT" });
  const payload = encode({ role: WATCHER_ROLE, iss: "supabase", iat: nowSeconds, exp: nowSeconds + TEN_YEARS_SECONDS });
  const signature = createHmac("sha256", jwtSecret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}
