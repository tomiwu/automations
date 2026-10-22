import { clip } from "./clip.ts";

/** Slug of the hub row. Low confidence with no last bot uses this slug. */
export const HUB_SLUG = "hub";

/** Virtual choice. It is not a registry row. The hub receives these messages. */
export const CREATE_NEW_BOT = "create_new_bot";

/** Default confidence limit. A lower value goes to the hub, or stays with the last bot. */
export const DEFAULT_CONFIDENCE = 0.6;

const ROUTE_INSTRUCTIONS =
  "Choose the bot for this message. Keep the last bot when this message continues the same topic. Choose another bot only when the topic clearly changes. Choose create_new_bot only when the person asks for a new bot.";

const HUB_CRITERION = "The Hub bot. Use it when no specialist fits or the person wants help to choose.";
const CREATE_CRITERION = "The person asks for a new bot that is not in the list.";

export interface RouteBot {
  slug: string;
  description: string;
}

export interface RouteState {
  currentText: string;
  hasPhoto: boolean;
  recent: { from: "person" | "bot"; text: string }[];
  lastBot: string | null;
}

export interface ChoiceAnswer {
  choice: string;
  confidence: number;
}

export interface RouteChoice {
  slug: string;
  intent: "message" | "create_new_bot";
  reason: string;
}

export interface MapRouteInput {
  answer: ChoiceAnswer | null;
  criteria: Readonly<Record<string, string>>;
  lastBot: string | null;
  routable: ReadonlySet<string>;
  threshold: number;
}

/** Criteria for the one Jev choice question. `create_new_bot` is always present. */
export function routeCriteria(bots: readonly RouteBot[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const bot of bots) addBotCriterion(criteria, bot);
  if (!criteria[HUB_SLUG]) criteria[HUB_SLUG] = HUB_CRITERION;
  criteria[CREATE_NEW_BOT] = CREATE_CRITERION;
  return criteria;
}

function addBotCriterion(criteria: Record<string, string>, bot: RouteBot): void {
  if (bot.slug === CREATE_NEW_BOT) return;
  criteria[bot.slug] = clip(bot.description, 300);
}

/** The Jev request: current message, recent turns, last bot, and one choice question. */
export function buildDecisionRequest(state: RouteState, bots: readonly RouteBot[]): {
  state: { current: { text: string; has_photo: boolean }; recent: RouteState["recent"]; last_bot: string | null };
  questions: { route: { type: "choice"; instructions: string; criteria: Record<string, string> } };
} {
  return {
    state: {
      current: { text: clip(state.currentText, 1000), has_photo: state.hasPhoto },
      recent: state.recent.slice(-6).map((turn) => ({ from: turn.from, text: clip(turn.text, 400) })),
      last_bot: state.lastBot,
    },
    questions: {
      route: { type: "choice", instructions: ROUTE_INSTRUCTIONS, criteria: routeCriteria(bots) },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function choiceText(route: Record<string, unknown>): string | null {
  if (typeof route.choice !== "string" || route.choice === "") return null;
  return route.choice;
}

function choiceConfidence(route: Record<string, unknown>): number | null {
  if (typeof route.confidence !== "number" || !Number.isFinite(route.confidence)) return null;
  return route.confidence;
}

function choiceRecord(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body) || !isRecord(body.answers)) return null;
  const answers = body.answers;
  if (!isRecord(answers.route)) return null;
  return answers.route;
}

/** Reads the `route` choice. Returns null when the body has no choice. */
export function readChoice(body: unknown): ChoiceAnswer | null {
  const route = choiceRecord(body);
  if (!route) return null;
  const choice = choiceText(route);
  const confidence = choiceConfidence(route);
  if (!choice || confidence === null) return null;
  return { choice, confidence };
}

function unsure(input: MapRouteInput): boolean {
  if (!input.answer) return true;
  if (!(input.answer.choice in input.criteria)) return true;
  return input.answer.confidence < input.threshold;
}

function stayOrHub(lastBot: string | null, routable: ReadonlySet<string>, reason: string): RouteChoice {
  if (lastBot && routable.has(lastBot)) return { slug: lastBot, intent: "message", reason };
  return { slug: HUB_SLUG, intent: "message", reason: `${reason}-hub` };
}

/**
 * Maps a Jev choice to a registry slug.
 * Confidence below the threshold does not count as a clear topic change:
 * the chat stays with the last bot when that bot is still routable, otherwise it goes to the hub.
 */
export function mapRoute(input: MapRouteInput): RouteChoice {
  if (unsure(input)) return stayOrHub(input.lastBot, input.routable, "low-confidence");
  const choice = input.answer?.choice ?? "";
  if (choice === CREATE_NEW_BOT) return { slug: HUB_SLUG, intent: "create_new_bot", reason: "create-new-bot" };
  if (!input.routable.has(choice)) return stayOrHub(input.lastBot, input.routable, "not-routable");
  return { slug: choice, intent: "message", reason: "choice" };
}
