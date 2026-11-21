import type { FetchCount } from "@automations/shared";
import { projectStream } from "@automations/librus-data";
import { checkKeys, inputObject, withFetches, type ExportDeps } from "./exports.ts";

const MAX_STREAM_LENGTH = 300;

export interface StreamHistoryEvent {
  seq: number;
  eventType: string;
  kind: string;
  day: string | null;
  recordedAt: string;
  contentHash: string;
  payload: Record<string, unknown>;
}

export interface StreamHistoryExport {
  stream: string;
  events: StreamHistoryEvent[];
  state: { state: Record<string, unknown>; vanished: boolean; seq: number; lastEventType: string; lastChanged: string } | null;
}

function checkStream(stream: unknown): string {
  if (typeof stream !== "string" || stream === "") throw new Error("stream must be a text.");
  if (stream.length > MAX_STREAM_LENGTH) throw new Error(`stream must be at most ${MAX_STREAM_LENGTH} characters.`);
  return stream;
}

/** Read-only export: the Journal events of one stream, oldest first, and the state they give. It reads Supabase only (1 fetch). */
export async function streamHistoryExport(deps: ExportDeps, input: unknown = {}): Promise<StreamHistoryExport & { fetches?: FetchCount }> {
  const object = inputObject(input);
  checkKeys(object, ["stream"]);
  const stream = checkStream(object.stream);
  const events = (await deps.storage.listEvents(deps.familyId, { streams: [stream] })).sort((a, b) => a.seq - b.seq);
  const head = events.length > 0 ? projectStream(events) : null;
  return withFetches(deps, {
    stream,
    events: events.map((e) => ({
      seq: e.seq, eventType: e.eventType, kind: e.kind, day: e.day, recordedAt: e.recordedAt.toISOString(), contentHash: e.contentHash, payload: e.payload,
    })),
    state: head && { state: head.state, vanished: head.vanished, seq: head.seq, lastEventType: head.lastEventType, lastChanged: head.lastChanged.toISOString() },
  });
}
