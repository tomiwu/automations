import type { JournalEvent, JournalFilter, NewJournalEvent } from "./storage.ts";

/** A SHA-256 hex digest of the JSON of a value. The keys of objects are sorted, so the digest is stable. */
export async function contentHash(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
  return Object.fromEntries(entries.map(([key, inner]) => [key, sortKeys(inner)]));
}

const stableJson = (value: unknown): string => JSON.stringify(sortKeys(value)) ?? "null";

/** One entity that a job saw in a download. */
export interface Observed<S> {
  stream: string;
  childId: string;
  kind: NewJournalEvent["kind"];
  day: string | null;
  state: S;
}

/** Gives the event types for one kind of stream. */
export interface Classifier<S> {
  added(state: S): string;
  changed(previous: S, next: S): string;
  vanished: string;
}

export interface PlanInput<S> {
  familyId: string;
  source: string;
  heads: readonly JournalEvent[];
  observed: readonly Observed<S>[];
  /** True if a head that is not observed must get a vanished event. */
  inVanishScope: (head: JournalEvent) => boolean;
  classify: Classifier<S>;
}

/** The events to append so that the heads show the observed states. */
export async function planEvents<S>(input: PlanInput<S>): Promise<NewJournalEvent[]> {
  const heads = new Map(input.heads.map((head) => [head.stream, head]));
  const seen = new Map(input.observed.map((item) => [item.stream, item]));
  const changes = await Promise.all([...seen.values()].map((item) => planObserved(input, item, heads.get(item.stream))));
  const gone = input.heads.filter((head) => !seen.has(head.stream) && isGone(input, head));
  const vanished = await Promise.all(gone.map((head) => vanishedEvent(input, head)));
  return [...changes.filter((event) => event !== null), ...vanished];
}

function isGone<S>(input: PlanInput<S>, head: JournalEvent): boolean {
  return head.eventType !== input.classify.vanished && input.inVanishScope(head);
}

async function planObserved<S>(input: PlanInput<S>, item: Observed<S>, head?: JournalEvent): Promise<NewJournalEvent | null> {
  const hash = await contentHash(item.state);
  const eventType = typeOf(input, item.state, hash, head);
  return eventType === null ? null : observedEvent(input, item, { seq: (head?.seq ?? 0) + 1, eventType, hash });
}

/** The event type for the observed state, or null if the head shows this state already. */
function typeOf<S>(input: PlanInput<S>, state: S, hash: string, head?: JournalEvent): string | null {
  if (!head || head.eventType === input.classify.vanished) return input.classify.added(state);
  return head.contentHash === hash ? null : input.classify.changed(head.payload as S, state);
}

function observedEvent<S>(
  input: PlanInput<S>,
  item: Observed<S>,
  next: { seq: number; eventType: string; hash: string },
): NewJournalEvent {
  return {
    familyId: input.familyId,
    childId: item.childId,
    stream: item.stream,
    seq: next.seq,
    kind: item.kind,
    day: item.day,
    eventType: next.eventType,
    payload: item.state as Record<string, unknown>,
    contentHash: next.hash,
    source: input.source,
  };
}

async function vanishedEvent<S>(input: PlanInput<S>, head: JournalEvent): Promise<NewJournalEvent> {
  return {
    familyId: input.familyId,
    childId: head.childId,
    stream: head.stream,
    seq: head.seq + 1,
    kind: head.kind,
    day: head.day,
    eventType: input.classify.vanished,
    payload: head.payload,
    contentHash: await contentHash({ ...head.payload, vanished: true }),
    source: input.source,
  };
}

export interface CheckInput {
  familyId: string;
  childId: string;
  stream: string;
  source: string;
  day: string | null;
  head?: JournalEvent;
  payload: Record<string, unknown>;
}

/** The `CheckCompleted` event for one successful pass of a job. */
export async function checkEvent(input: CheckInput): Promise<NewJournalEvent> {
  return {
    familyId: input.familyId,
    childId: input.childId,
    stream: input.stream,
    seq: (input.head?.seq ?? 0) + 1,
    kind: "check",
    day: input.day,
    eventType: "CheckCompleted",
    payload: input.payload,
    contentHash: await contentHash(input.payload),
    source: input.source,
  };
}

/** The current state of one stream. */
export interface StreamState {
  stream: string;
  /** The Journal `child_id` of the stream. */
  childId: string;
  state: Record<string, unknown>;
  vanished: boolean;
  seq: number;
  lastEventType: string;
  lastChanged: Date;
}

const stateOf = (event: JournalEvent): StreamState => ({
  stream: event.stream,
  childId: event.childId,
  state: event.payload,
  vanished: event.eventType.endsWith("Vanished"),
  seq: event.seq,
  lastEventType: event.eventType,
  lastChanged: event.recordedAt,
});

/** Folds the events of one stream, in `seq` order. Each event carries the whole state, so the last event gives it. */
export function projectStream(events: readonly JournalEvent[]): StreamState {
  const last = events[events.length - 1];
  if (!last) throw new Error("A stream with no events has no state");
  return stateOf(last);
}

/** The state of each stream from the heads only. */
export const projectHeads = (heads: readonly JournalEvent[]): StreamState[] => heads.map(stateOf);

const afterFrom = (day: string, from?: string): boolean => from === undefined || day >= from;
const beforeTo = (day: string, to?: string): boolean => to === undefined || day <= to;

/** True if the day is inside the optional bounds. An event with no day is outside any bound. */
function inRange(day: string | null, filter: JournalFilter): boolean {
  if (filter.from === undefined && filter.to === undefined) return true;
  return day !== null && afterFrom(day, filter.from) && beforeTo(day, filter.to);
}

function inList<T>(allowed: readonly T[] | undefined, value: T): boolean {
  return allowed === undefined || allowed.includes(value);
}

const isSince = (event: JournalEvent, since?: Date): boolean =>
  since === undefined || event.recordedAt.getTime() >= since.getTime();

const isListed = (event: JournalEvent, filter: JournalFilter): boolean =>
  (filter.childId === undefined || event.childId === filter.childId) &&
  inList(filter.kinds, event.kind) &&
  inList(filter.streams, event.stream);

/** True if the event passes the filter. */
export function matchesJournalFilter(event: JournalEvent, filter: JournalFilter): boolean {
  return isListed(event, filter) && isSince(event, filter.since) && inRange(event.day, filter);
}
