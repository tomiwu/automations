import { registerBot, type RegisterResult } from "../register.ts";
import { registerDeps } from "./common.ts";

/**
 * Adds or updates one bot in the registry. The hub calls this after it creates a bot.
 * The webhook key is encrypted before storage. The result does not contain the key.
 *
 * @param input - `{ slug, name, description, webhookUrl, webhookKey, activeHours?, active? }`. Unknown keys are rejected.
 * @returns `{ ok: true, slug }`.
 *
 * @example
 * import registerBot from "kody:@tomiwu/kradziejka/register-bot";
 * await registerBot({
 *   slug: "grades",
 *   name: "Grades",
 *   description: "Questions about grades.",
 *   webhookUrl: "https://api2.cursor.sh/automations/webhook/example",
 *   webhookKey: "example-webhook-key",
 *   activeHours: "always",
 * });
 */
export default async function register(input: unknown): Promise<RegisterResult> {
  return registerBot(await registerDeps(), input);
}
