import { clip } from "./clip.ts";
import { asRecord } from "./input.ts";

export interface KeyValue {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
}

export interface ChatTurn {
  from: "person" | "bot";
  text: string;
  at: string;
}

export interface ChatState {
  lastBot: string | null;
  messages: ChatTurn[];
}

const EMPTY: ChatState = { lastBot: null, messages: [] };
const MAX_TURNS = 8;

export function chatKey(chatId: string): string {
  if (!/^[0-9]{1,20}$/.test(chatId)) throw new Error("chat_id must be a decimal id.");
  return `chat:${chatId}`;
}

/** Reads the short memory of one chat. A missing or bad value is an empty chat. */
export async function loadChat(kv: KeyValue, chatId: string): Promise<ChatState> {
  const raw = await kv.get(chatKey(chatId));
  return parseChat(raw);
}

export function parseChat(raw: unknown): ChatState {
  const data = typeof raw === "string" ? parseJson(raw) : raw;
  const record = asChat(data);
  if (!record) return EMPTY;
  return { lastBot: record.lastBot, messages: record.messages.slice(-MAX_TURNS) };
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function asChat(data: unknown): ChatState | null {
  const record = asRecord(data);
  if (!record) return null;
  if (!validLastBot(record.lastBot)) return null;
  if (!Array.isArray(record.messages)) return null;
  return { lastBot: record.lastBot, messages: record.messages.map(asTurn).filter(isTurn) };
}

function validLastBot(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isTurn(value: ChatTurn | null): value is ChatTurn {
  return value !== null;
}

function asTurn(value: unknown): ChatTurn | null {
  const record = asRecord(value);
  if (!record) return null;
  if (!isSpeaker(record.from)) return null;
  if (!isText(record.text) || !isText(record.at)) return null;
  return { from: record.from, text: record.text, at: record.at };
}

function isSpeaker(value: unknown): value is ChatTurn["from"] {
  return value === "person" || value === "bot";
}

function isText(value: unknown): value is string {
  return typeof value === "string";
}

export async function saveChat(kv: KeyValue, chatId: string, state: ChatState): Promise<void> {
  const next = { lastBot: state.lastBot, messages: state.messages.slice(-MAX_TURNS) };
  await kv.set(chatKey(chatId), JSON.stringify(next));
}

/** Appends one turn and keeps the last eight messages. */
export function appendTurn(state: ChatState, from: ChatTurn["from"], text: string, at: string): ChatState {
  const turn = { from, text: clip(text, 400), at };
  return { lastBot: state.lastBot, messages: [...state.messages, turn].slice(-MAX_TURNS) };
}

/** Records the person message and the bot that received it. */
export function rememberRoute(state: ChatState, text: string, slug: string, at: string): ChatState {
  return { ...appendTurn(state, "person", text, at), lastBot: slug };
}
