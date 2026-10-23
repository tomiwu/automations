import { kodyAppBasePath } from "@automations/shared/kody";
import { handleDashboard } from "../dashboard.ts";
import { dashboardDeps } from "./common.ts";

/**
 * Serves the Dashboard (read view). Open it in a browser after `./configure`. Sign in with a user from the allowlist.
 *
 * @param request - The HTTP request for the hosted app. The mount prefix is already removed.
 * @returns An HTML page, a redirect, or a plain-text error.
 *
 * @example
 * import app from "kody:@tomiwu/payments-watch/app";
 * const page = await app(new Request("https://example.test/login"));
 */
export default async function app(request: Request): Promise<Response> {
  try {
    return await handleDashboard(request, await dashboardDeps(), kodyAppBasePath());
  } catch {
    return new Response("The app failed. Error code: app_failed.", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}
