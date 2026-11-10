import { localDate, type FetchCount } from "@automations/shared";
import type { JournalEvent } from "@automations/librus-data";
import { checkChildId, checkKeys, inputObject, withFetches, type ExportDeps } from "@tomiwu/librus-watch";

const MAX_MONTHS_BACK = 12;
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

export interface StoredPayment {
  stream: string;
  seq: number;
  eventType: string;
  lastChanged: string;
  childId: string;
  feeId: string;
  organizer: string;
  month: string;
  dueDay: number;
  status: "pending" | "paid" | "skipped";
  amount: number;
  amountSource: string;
  notifiedAt: string | null;
  remindedAt: string | null;
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface StoredPaymentsExport {
  timezone: string;
  month: string;
  /** The time of the last `CheckCompleted` of each Child, or null before the first check. */
  lastSavedAt: Record<string, string | null>;
  payments: StoredPayment[];
}

const monthIndex = (month: string): number => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1;

function resolveMonth(value: unknown, today: string): string {
  const current = today.slice(0, 7);
  if (value === undefined) return current;
  if (typeof value !== "string" || !MONTH_PATTERN.test(value)) throw new Error("month must be YYYY-MM.");
  if (monthIndex(current) - monthIndex(value) > MAX_MONTHS_BACK) {
    throw new Error(`month must be at most ${MAX_MONTHS_BACK} months back.`);
  }
  return value;
}

function paymentOf(head: JournalEvent): StoredPayment {
  const p = head.payload as unknown as Omit<StoredPayment, "stream" | "seq" | "eventType" | "lastChanged">;
  return {
    stream: head.stream, seq: head.seq, eventType: head.eventType, lastChanged: head.recordedAt.toISOString(),
    childId: head.childId, feeId: p.feeId, organizer: p.organizer, month: p.month, dueDay: p.dueDay, status: p.status,
    amount: p.amount, amountSource: p.amountSource,
    notifiedAt: p.notifiedAt ?? null, remindedAt: p.remindedAt ?? null, decidedAt: p.decidedAt ?? null, decidedBy: p.decidedBy ?? null,
  };
}

const byDueDay = (a: StoredPayment, b: StoredPayment): number => a.dueDay - b.dueDay || a.stream.localeCompare(b.stream);

function savedAt(childIds: readonly string[], checks: readonly JournalEvent[]): Record<string, string | null> {
  return Object.fromEntries(
    childIds.map((id) => {
      const head = checks.find((check) => check.stream === `check:payments-watch:${id}`);
      return [id, head?.recordedAt.toISOString() ?? null];
    }),
  );
}

/**
 * Read-only export: the Payments of one month as the Journal stores them, and the time of the last check of each
 * Child. It reads Supabase only (3 fetches at most). It never returns an account, NIP, title or source URL.
 */
export async function storedPaymentsExport(deps: ExportDeps, input: unknown = {}): Promise<StoredPaymentsExport & { fetches?: FetchCount }> {
  const object = inputObject(input);
  checkKeys(object, ["childId", "month"]);
  const childId = checkChildId(object.childId);
  const config = await deps.storage.loadConfig(deps.familyId);
  const timezone = config.family.timezone;
  const month = resolveMonth(object.month, localDate(deps.runtime.now(), timezone));
  const childIds = config.children.map((child) => child.id);
  if (childId !== undefined && !childIds.includes(childId)) throw new Error(`Unknown child: ${childId}.`);
  const scope = childId === undefined ? childIds : [childId];
  const heads = await deps.storage.listHeads(deps.familyId, { childId, kinds: ["payment"], from: `${month}-01`, to: `${month}-31` });
  const checks = await deps.storage.listHeads(deps.familyId, { streams: scope.map((id) => `check:payments-watch:${id}`) });
  return withFetches(deps, {
    timezone, month, lastSavedAt: savedAt(scope, checks), payments: heads.map(paymentOf).sort(byDueDay),
  });
}
