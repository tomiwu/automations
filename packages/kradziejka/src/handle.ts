import { senderAllowed } from "./allowlist.ts";
import { buildForwardPayload, type PhotoInfo } from "./payload.ts";
import { buildDecisionRequest, mapRoute, readChoice, routeCriteria, type ChoiceAnswer, type RouteChoice } from "./routing.ts";
import { isRoutable, type BotRecord, type BotRegistry } from "./registry.ts";
import type { SpeechToText, VoiceNote } from "./speech.ts";
import { appendTurn, loadChat, rememberRoute, saveChat, type ChatState, type KeyValue } from "./state.ts";
import { text } from "./text.ts";
import { claimUpdate, releaseUpdate } from "./updates.ts";
import { parseInbound, type Inbound } from "./inbound.ts";

export interface TelegramPort {
  typing(chatId: string): Promise<void>;
  send(chatId: string, text: string): Promise<void>;
}

export interface HandlerDeps {
  familyId: string;
  allowlist: readonly string[];
  threshold: number;
  timezone: string;
  kv: KeyValue;
  registry: BotRegistry;
  telegram: TelegramPort;
  speech: SpeechToText;
  now(): Date;
  decide(body: unknown): Promise<unknown>;
  forward(url: string, key: string, payload: unknown): Promise<void>;
  openKey(slug: string, ciphertext: string): Promise<string>;
}

export interface HandleResult {
  ok: true;
  status: "ignored" | "duplicate" | "dropped" | "rejected" | "hub-missing" | "forward-failed" | "forwarded";
  slug?: string;
}

type Content = { kind: "reject"; notice: string } | { kind: "text"; text: string; photo: PhotoInfo | null };

/** Handles one Telegram update. A non-allowlisted sender gets no reply. */
export async function handleTelegramUpdate(deps: HandlerDeps, raw: unknown): Promise<HandleResult> {
  const inbound = parseInbound(raw);
  if (!inbound) return { ok: true, status: "ignored" };
  if (!(await claimUpdate(deps.kv, inbound.updateId))) return { ok: true, status: "duplicate" };
  try {
    return await acceptOrDrop(deps, inbound);
  } catch (error) {
    await releaseUpdate(deps.kv, inbound.updateId);
    throw error;
  }
}

async function acceptOrDrop(deps: HandlerDeps, inbound: Inbound): Promise<HandleResult> {
  if (!senderAllowed(deps.allowlist, inbound)) return { ok: true, status: "dropped" };
  await deps.telegram.typing(inbound.chatId);
  await deps.telegram.send(inbound.chatId, text.ack);
  return routeAndForward(deps, inbound);
}

async function routeAndForward(deps: HandlerDeps, inbound: Inbound): Promise<HandleResult> {
  const content = await contentFrom(deps.speech, inbound);
  if (content.kind === "reject") return rejectContent(deps, inbound.chatId, content.notice);
  const state = await loadChat(deps.kv, inbound.chatId);
  const chosen = await chooseRoute(deps, content, state);
  const sent = await forwardChoice(deps, inbound, content, state, chosen);
  if (sent.status !== "forwarded") return sent;
  const at = deps.now().toISOString();
  await saveChat(deps.kv, inbound.chatId, rememberRoute(state, memoryText(content), chosen.choice.slug, at));
  return sent;
}

function memoryText(content: { text: string }): string {
  if (content.text !== "") return content.text;
  return "[photo]";
}

async function rejectContent(deps: HandlerDeps, chatId: string, notice: string): Promise<HandleResult> {
  await deps.telegram.send(chatId, notice);
  return { ok: true, status: "rejected" };
}

function isVoiceOnly(inbound: Inbound): boolean {
  return Boolean(inbound.voice) && inbound.text === "" && !inbound.photo;
}

async function contentFrom(speech: SpeechToText, inbound: Inbound): Promise<Content> {
  if (isVoiceOnly(inbound)) return voiceContent(speech, inbound.voice as VoiceNote);
  if (inbound.text === "" && !inbound.photo) return { kind: "reject", notice: text.unsupported };
  return { kind: "text", text: inbound.text, photo: inbound.photo };
}

async function voiceContent(speech: SpeechToText, voice: VoiceNote): Promise<Content> {
  const transcript = await speech.transcribe(voice);
  if (!transcript) return { kind: "reject", notice: text.voiceLater };
  return { kind: "text", text: transcript, photo: null };
}

async function chooseRoute(
  deps: HandlerDeps,
  content: Extract<Content, { kind: "text" }>,
  state: ChatState,
): Promise<{ choice: RouteChoice; bots: BotRecord[] }> {
  const bots = await deps.registry.list(deps.familyId);
  const open = bots.filter((bot) => isRoutable(bot, deps.now(), deps.timezone));
  const answer = await askJev(deps, content, state, open);
  const choice = mapRoute({
    answer,
    criteria: routeCriteria(open),
    lastBot: state.lastBot,
    routable: new Set(open.map((bot) => bot.slug)),
    threshold: deps.threshold,
  });
  return { choice, bots };
}

async function askJev(
  deps: HandlerDeps,
  content: Extract<Content, { kind: "text" }>,
  state: ChatState,
  open: readonly BotRecord[],
): Promise<ChoiceAnswer | null> {
  try {
    const raw = await deps.decide(decisionBody(content, state, open));
    return readChoice(raw);
  } catch {
    return null;
  }
}

function decisionBody(content: Extract<Content, { kind: "text" }>, state: ChatState, open: readonly BotRecord[]) {
  return buildDecisionRequest(
    {
      currentText: content.text,
      hasPhoto: content.photo !== null,
      recent: state.messages.map((turn) => ({ from: turn.from, text: turn.text })),
      lastBot: state.lastBot,
    },
    open,
  );
}

async function forwardChoice(
  deps: HandlerDeps,
  inbound: Inbound,
  content: Extract<Content, { kind: "text" }>,
  state: ChatState,
  chosen: { choice: RouteChoice; bots: BotRecord[] },
): Promise<HandleResult> {
  const bot = chosen.bots.find((item) => item.slug === chosen.choice.slug);
  if (!bot) return missingHub(deps, inbound.chatId);
  try {
    await sendPayload(deps, inbound, content, state, chosen.choice, bot);
    return { ok: true, status: "forwarded", slug: chosen.choice.slug };
  } catch {
    await deps.telegram.send(inbound.chatId, text.forwardFailed);
    return { ok: true, status: "forward-failed" };
  }
}

async function missingHub(deps: HandlerDeps, chatId: string): Promise<HandleResult> {
  await deps.telegram.send(chatId, text.hubMissing);
  return { ok: true, status: "hub-missing" };
}

async function sendPayload(
  deps: HandlerDeps,
  inbound: Inbound,
  content: Extract<Content, { kind: "text" }>,
  state: ChatState,
  choice: RouteChoice,
  bot: BotRecord,
): Promise<void> {
  const key = await deps.openKey(bot.slug, bot.webhookKeyCiphertext);
  const payload = buildForwardPayload({
    chatId: inbound.chatId,
    userId: inbound.userId,
    languageCode: inbound.languageCode,
    text: content.text,
    photo: content.photo,
    recent: state.messages,
    lastBot: state.lastBot,
    route: choice,
  });
  await deps.forward(bot.webhookUrl, key, payload);
}

/** Appends a bot reply to the chat memory. The reply webhook uses this. */
export async function rememberReply(kv: KeyValue, chatId: string, replyText: string, at: string): Promise<void> {
  const state = await loadChat(kv, chatId);
  await saveChat(kv, chatId, appendTurn(state, "bot", replyText, at));
}
