import { contentHash } from "@automations/librus-data";
import type { RestClient, Row } from "./rest.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isoDate(value: string, name: string): string {
  const real = DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!real) throw new Error(`Option --${name} must be a real date YYYY-MM-DD`);
  return value;
}

export const manualStream = (childId: string, from: string): string => `item:manualDaysOff:${childId}:${from}`;

export interface DayOffInput {
  childId: string;
  from: string;
  to: string;
  reason: string;
  sourceStream: string;
}

export function dayOffPayload(input: DayOffInput): Record<string, unknown> {
  return {
    scope: `manualDaysOff:${input.childId}`,
    sourceId: input.from,
    kind: "dayOff",
    childId: input.childId,
    date: input.from,
    startTime: null,
    endTime: null,
    title: "Dzień wolny",
    text: `${input.from} - ${input.to}\n${input.reason}`,
    sender: null,
    subject: null,
    category: null,
    sourceUpdatedAt: null,
    sourceStream: input.sourceStream,
  };
}

export type JournalRow = {
  family_id: string;
  child_id: string;
  stream: string;
  seq: number;
  kind: "dayOff";
  day: string;
  event_type: "ItemRecorded" | "ItemChanged";
  payload: Record<string, unknown>;
  content_hash: string;
  source: "admin";
};

export async function nextEvent(base: Pick<JournalRow, "family_id" | "child_id" | "stream" | "day">, payload: Record<string, unknown>, head: Row | undefined): Promise<JournalRow | null> {
  const hash = await contentHash(payload);
  if (head?.content_hash === hash) return null;
  const seq = head === undefined ? 1 : Number(head.seq) + 1;
  return { ...base, seq, kind: "dayOff", event_type: head === undefined ? "ItemRecorded" : "ItemChanged", payload, content_hash: hash, source: "admin" };
}

const eq = (value: string): string => encodeURIComponent(value);

export async function headOf(rest: RestClient, familyId: string, stream: string): Promise<Row | undefined> {
  const query = `select=stream,seq,content_hash,payload&family_id=eq.${eq(familyId)}&stream=eq.${eq(stream)}`;
  return (await rest.select("journal_heads", query))[0];
}

export async function familyOf(rest: RestClient, childId: string): Promise<string> {
  const child = (await rest.select("children", `select=family_id&id=eq.${eq(childId)}`))[0];
  if (child === undefined) throw new Error(`No Child with id ${childId}`);
  return String(child.family_id);
}
