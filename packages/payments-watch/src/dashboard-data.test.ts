import { describe, expect, it } from "vitest";
import type { Fee, Payment } from "@automations/librus-data";
import { buildDashboard, schoolYearOf } from "./dashboard-data.ts";

const FAMILY = "00000000-0000-4000-8000-000000000001";
const fee = (id: string, childId: string, dueDay = 20): Fee => ({
  id,
  familyId: FAMILY,
  childId,
  organizer: `Organizer ${id}`,
  recipientName: "Example Recipient",
  nip: null,
  account: "61109010140000071219812874",
  title: "Example fee",
  dueDay,
  notifyDay: 10,
  reminderDay: 14,
  amounts: {},
  sourceUrl: null,
  accountId: null,
  enabled: true,
});
const payment = (id: string, feeId: string, month: string, amount: number, status: Payment["status"]): Payment => ({
  id,
  familyId: FAMILY,
  feeId,
  month,
  amount,
  amountSource: "config",
  status,
  notifiedAt: null,
  remindedAt: null,
  decidedAt: null,
  decidedBy: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
});
const children = [
  { id: "c1", name: "Child One" },
  { id: "c2", name: "Child Two" },
];
const fees = [fee("f1", "c1"), fee("f2", "c2", 5)];

describe("schoolYearOf", () => {
  it("maps September to December to the year that starts", () => {
    expect(schoolYearOf("2025-09")).toBe("2025/2026");
    expect(schoolYearOf("2025-12")).toBe("2025/2026");
  });
  it("maps January to June to the year that started before", () => {
    expect(schoolYearOf("2026-01")).toBe("2025/2026");
    expect(schoolYearOf("2026-06")).toBe("2025/2026");
  });
  it("gives nothing for July and August", () => {
    expect(schoolYearOf("2026-07")).toBeNull();
    expect(schoolYearOf("2026-08")).toBeNull();
  });
});

describe("buildDashboard", () => {
  const payments = [
    payment("p1", "f1", "2025-12", 10000, "paid"),
    payment("p2", "f1", "2026-01", 15050, "paid"),
    payment("p3", "f1", "2026-01", 999, "skipped"),
    payment("p4", "f2", "2026-01", 2000, "paid"),
    payment("p5", "f2", "2026-02", 3000, "pending"),
    payment("p6", "f1", "2026-02", 4000, "pending"),
    payment("p7", "f1", "2026-07", 500, "paid"),
    payment("p8", "gone", "2026-01", 700, "paid"),
  ];
  const view = buildDashboard({ children, fees, payments, today: "2026-02-10" });

  it("splits paid and unpaid rows", () => {
    expect(view.paid.map((row) => row.paymentId)).toEqual(["p1", "p2", "p4", "p7"]);
    expect(view.unpaid.map((row) => row.paymentId)).toEqual(["p5", "p6"]);
  });

  it("fills a row with the child, the organizer and the due date", () => {
    expect(view.unpaid[0]).toMatchObject({ child: "Child Two", organizer: "Organizer f2", dueDate: "2026-02-05", amount: 3000 });
  });

  it("lists next due as pending Payments from today, soonest first", () => {
    expect(view.nextDue.map((row) => row.paymentId)).toEqual(["p6"]);
  });

  it("sums paid spend per Child and month", () => {
    expect(view.spendByMonth).toEqual([
      { child: "Child One", month: "2025-12", total: 10000 },
      { child: "Child One", month: "2026-01", total: 15050 },
      { child: "Child One", month: "2026-07", total: 500 },
      { child: "Child Two", month: "2026-01", total: 2000 },
    ]);
  });

  it("sums paid spend per Child and school year", () => {
    expect(view.spendBySchoolYear).toEqual([
      { child: "Child One", schoolYear: "2025/2026", total: 25050 },
      { child: "Child Two", schoolYear: "2025/2026", total: 2000 },
    ]);
  });

  it("gives empty lists for no Payments", () => {
    expect(buildDashboard({ children, fees, payments: [], today: "2026-02-10" })).toEqual({
      paid: [],
      unpaid: [],
      cancelled: [],
      nextDue: [],
      spendByMonth: [],
      spendBySchoolYear: [],
    });
  });
});
