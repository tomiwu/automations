import type { Fee, Payment } from "@automations/librus-data";
import { localDate, localTime } from "@automations/shared";

/** Who marked a Payment paid. The Telegram chat ID is not kept. */
export type MarkedBy =
  | { kind: "telegram" }
  | { kind: "dashboard"; user: string }
  | { kind: "organizer"; service: string }
  | { kind: "unknown" };

export interface DashboardRow {
  paymentId: string;
  child: string;
  organizer: string;
  month: string;
  dueDate: string;
  /** Grosze. */
  amount: number;
  status: Payment["status"];
  /** The Organizer no longer lists this paid charge (payments contract v0.2, PC2). */
  refundCheck: boolean;
  /** When the Payment was decided: local `YYYY-MM-DD HH:MM` in the Family time zone, or null. */
  decidedAt: string | null;
  markedBy: MarkedBy;
  amountSource: Payment["amountSource"];
}

export interface MonthSpend {
  child: string;
  month: string;
  total: number;
}

export interface SchoolYearSpend {
  child: string;
  schoolYear: string;
  total: number;
}

export interface Dashboard {
  paid: DashboardRow[];
  unpaid: DashboardRow[];
  /** History only: not in "next due" and not in spend (payments contract v0.2, PC3). */
  cancelled: DashboardRow[];
  nextDue: DashboardRow[];
  spendByMonth: MonthSpend[];
  spendBySchoolYear: SchoolYearSpend[];
}

export interface DashboardInput {
  children: readonly { id: string; name: string }[];
  fees: readonly Fee[];
  payments: readonly Payment[];
  /** The date in the Family time zone, `YYYY-MM-DD`. */
  today: string;
  /** The Family time zone, for example `Europe/Warsaw`. */
  timezone: string;
}

const pad = (value: number): string => String(value).padStart(2, "0");

/** The school year of a month `YYYY-MM` (September to June), for example "2025/2026". July and August give null. */
export function schoolYearOf(month: string): string | null {
  const year = Number(month.slice(0, 4));
  const number = Number(month.slice(5, 7));
  if (number >= 9) return `${year}/${year + 1}`;
  if (number <= 6) return `${year - 1}/${year}`;
  return null;
}

const TELEGRAM_CHAT_ID = /^-?\d+$/;
const ORGANIZER_PREFIX = "organizer:";

const organizerOf = (service: string): MarkedBy => (service === "" ? { kind: "unknown" } : { kind: "organizer", service });

/**
 * Maps `decided_by` to a kind. A chat ID is a Telegram press, `organizer:<service>` is the automatic match, any other
 * text is a Dashboard user name. Null and an empty text are unknown.
 */
export function markedByOf(decidedBy: string | null): MarkedBy {
  if (!decidedBy) return { kind: "unknown" };
  if (TELEGRAM_CHAT_ID.test(decidedBy)) return { kind: "telegram" };
  if (decidedBy.startsWith(ORGANIZER_PREFIX)) return organizerOf(decidedBy.slice(ORGANIZER_PREFIX.length));
  return { kind: "dashboard", user: decidedBy };
}

function localDateTime(date: Date | null, timezone: string): string | null {
  return date === null ? null : `${localDate(date, timezone)} ${localTime(date, timezone)}`;
}

function toRow(payment: Payment, fee: Fee, child: string, timezone: string): DashboardRow {
  return {
    paymentId: payment.id,
    child,
    organizer: fee.organizer,
    month: payment.month,
    dueDate: `${payment.month}-${pad(fee.dueDay)}`,
    amount: payment.amount,
    status: payment.status,
    refundCheck: payment.refundCheckAt !== null,
    decidedAt: localDateTime(payment.decidedAt, timezone),
    markedBy: markedByOf(payment.decidedBy),
    amountSource: payment.amountSource,
  };
}

function rowsOf(input: DashboardInput): DashboardRow[] {
  const rows: DashboardRow[] = [];
  for (const payment of input.payments) {
    const fee = input.fees.find((candidate) => candidate.id === payment.feeId);
    const child = input.children.find((candidate) => candidate.id === fee?.childId);
    if (fee && child) rows.push(toRow(payment, fee, child.name, input.timezone));
  }
  return rows;
}

function sumBy<K extends { child: string }>(rows: readonly DashboardRow[], keyOf: (row: DashboardRow) => K | null): (K & { total: number })[] {
  const sums = new Map<string, K & { total: number }>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!key) continue;
    const id = JSON.stringify(key);
    const entry = sums.get(id) ?? { ...key, total: 0 };
    entry.total += row.amount;
    sums.set(id, entry);
  }
  return [...sums.values()].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

/** Newest decision first by the real instant, not the local text (DST repeats an hour). A row without a date goes last. */
function newestFirst(rows: readonly DashboardRow[], payments: readonly Payment[]): DashboardRow[] {
  const instants = new Map(payments.map((payment) => [payment.id, payment.decidedAt?.getTime() ?? 0]));
  const instant = (row: DashboardRow): number => instants.get(row.paymentId) ?? 0;
  return [...rows].sort((a, b) => instant(b) - instant(a));
}

/**
 * Builds the read view of the Dashboard. Spend counts `paid` Payments only. A Payment of a Fee or Child that is
 * not known is left out.
 */
export function buildDashboard(input: DashboardInput): Dashboard {
  const rows = rowsOf(input);
  const paid = rows.filter((row) => row.status === "paid");
  const unpaid = rows.filter((row) => row.status === "pending");
  return {
    paid: newestFirst(paid, input.payments),
    unpaid,
    cancelled: rows.filter((row) => row.status === "cancelled"),
    nextDue: unpaid.filter((row) => row.dueDate >= input.today).sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    spendByMonth: sumBy(paid, (row) => ({ child: row.child, month: row.month })),
    spendBySchoolYear: sumBy(paid, (row) => {
      const schoolYear = schoolYearOf(row.month);
      return schoolYear === null ? null : { child: row.child, schoolYear };
    }),
  };
}
