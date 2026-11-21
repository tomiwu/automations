import { paymentStream, type Fee, type Payment } from "@automations/librus-data";
import type { PageObservation } from "./fee-source.ts";

/** The number of consecutive successful passes that must show a candidate cancel before the Payment is cancelled. */
export const CANCEL_AFTER = 2;

/** The part of the Kody package storage that holds the counters. The counters are not in the Journal. */
export interface CounterStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
}

type Reason = "organizer_void" | "organizer_withdrawn";

export type Counters = Record<string, { reason: Reason; count: number }>;

export interface Watched {
  fee: Fee;
  payment: Payment;
  observation: PageObservation;
}

export interface CancelDue {
  watched: Watched;
  reason: Reason;
  evidence: string;
}

export interface CounterStep {
  counters: Counters;
  due: CancelDue[];
  listed: Watched[];
}

const COUNTERS_KEY = "organizerCancelCounters";

function parseCounters(text: unknown): Counters {
  try {
    const parsed: unknown = JSON.parse(String(text ?? ""));
    return parsed && typeof parsed === "object" ? (parsed as Counters) : {};
  } catch {
    return {};
  }
}

export const loadCounters = async (store: CounterStore): Promise<Counters> => parseCounters(await store.get(COUNTERS_KEY));

export const saveCounters = (store: CounterStore, counters: Counters): Promise<unknown> =>
  store.set(COUNTERS_KEY, JSON.stringify(counters));

const streamOf = ({ fee, payment }: Watched): string => paymentStream(fee.childId, fee.id, payment.month);

type Candidate = Extract<PageObservation, { kind: "candidate" }>;

function countCandidate(item: Watched, candidate: Candidate, previous: Counters[string] | undefined, step: CounterStep): void {
  const count = (previous?.reason === candidate.reason ? previous.count : 0) + 1;
  if (count >= CANCEL_AFTER) step.due.push({ watched: item, reason: candidate.reason, evidence: candidate.evidence });
  else step.counters[streamOf(item)] = { reason: candidate.reason, count };
}

const isCounted = ({ status, refundCheckAt }: Payment): boolean => status === "pending" || (status === "paid" && refundCheckAt === null);

function advanceOne(item: Watched, previous: Counters[string] | undefined, step: CounterStep): void {
  const { observation, payment } = item;
  if (observation.kind === "listed") {
    if (payment.status === "cancelled") step.listed.push(item);
    return;
  }
  if (isCounted(payment)) countCandidate(item, observation, previous, step);
}

export function advanceCounters(stored: Counters, watched: readonly Watched[], month: string): CounterStep {
  const counters: Counters = Object.fromEntries(Object.entries(stored).filter(([stream]) => stream.endsWith(`:${month}`)));
  const step: CounterStep = { counters, due: [], listed: [] };
  for (const item of watched) {
    delete counters[streamOf(item)];
    advanceOne(item, stored[streamOf(item)], step);
  }
  return step;
}
