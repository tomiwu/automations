import type { Fee, Payment } from "@automations/librus-data";

export interface DashboardRow {
  paymentId: string;
  child: string;
  organizer: string;
  month: string;
  dueDate: string;
  /** Grosze. */
  amount: number;
  status: Payment["status"];
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

function toRow(payment: Payment, fee: Fee, child: string): DashboardRow {
  return {
    paymentId: payment.id,
    child,
    organizer: fee.organizer,
    month: payment.month,
    dueDate: `${payment.month}-${pad(fee.dueDay)}`,
    amount: payment.amount,
    status: payment.status,
  };
}

function rowsOf(input: DashboardInput): DashboardRow[] {
  const rows: DashboardRow[] = [];
  for (const payment of input.payments) {
    const fee = input.fees.find((candidate) => candidate.id === payment.feeId);
    const child = input.children.find((candidate) => candidate.id === fee?.childId);
    if (fee && child) rows.push(toRow(payment, fee, child.name));
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

/**
 * Builds the read view of the Dashboard. Spend counts `paid` Payments only. A Payment of a Fee or Child that is
 * not known is left out.
 */
export function buildDashboard(input: DashboardInput): Dashboard {
  const rows = rowsOf(input);
  const paid = rows.filter((row) => row.status === "paid");
  const unpaid = rows.filter((row) => row.status === "pending");
  return {
    paid,
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
