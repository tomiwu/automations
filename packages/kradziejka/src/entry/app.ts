import { packageContext } from "kody:runtime";
import { handleAdmin } from "../admin.ts";
import { adminDeps } from "./common.ts";

/**
 * Serves the registry admin page.
 * Open it in a browser after `./configure`. Sign in with the admin token.
 *
 * @param request - The HTTP request for the hosted app. The mount prefix is already removed.
 * @returns An HTML page, a redirect, or a plain-text error.
 *
 * @example
 * import app from "kody:@tomiwu/kradziejka/app";
 * const page = await app(new Request("https://example.test/login"));
 */
export default async function app(request: Request): Promise<Response> {
  const base = packageContext?.appBasePath ?? "";
  try {
    return await handleAdmin(request, await adminDeps(), base);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The app failed.";
    return new Response(message, { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}
