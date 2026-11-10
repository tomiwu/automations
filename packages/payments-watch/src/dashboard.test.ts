import { createMemoryStorage } from "@automations/librus-data";
import type { Fee } from "@automations/librus-data";
import type { Config } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { handleDashboard, tokenDigest, type DashboardDeps } from "./dashboard.ts";

const FAMILY = "00000000-0000-4000-8000-000000000001";
const CHILD = "00000000-0000-4000-8000-0000000000c1";
const config: Config = {
  family: { id: FAMILY, name: "Example Family", timezone: "Europe/Warsaw", default_language: "en" },
  children: [{ id: CHILD, family_id: FAMILY, name: "Child One", has_librus: true, calendar_id: null }],
  accounts: [],
  activities: [],
  recipients: [],
};
const fee: Fee = {
  id: "00000000-0000-4000-8000-0000000000f1",
  familyId: FAMILY,
  childId: CHILD,
  organizer: "Example <Organizer>",
  recipientName: "Example Recipient",
  nip: null,
  account: "61109010140000071219812874",
  title: "Example fee",
  dueDay: 20,
  notifyDay: 10,
  reminderDay: 14,
  amounts: {},
  sourceUrl: null,
  accountId: null,
  enabled: true,
};
const TOKEN = "example-token-one";

async function deps(): Promise<DashboardDeps> {
  const storage = createMemoryStorage({ configs: [config] });
  storage.setFee(fee);
  await storage.upsertPayment({ familyId: FAMILY, feeId: fee.id, month: "2026-02", amount: 15050, amountSource: "config" });
  const paid = await storage.upsertPayment({ familyId: FAMILY, feeId: fee.id, month: "2026-01", amount: 12000, amountSource: "config" });
  await storage.setPaymentStatus(paid.id, "paid", "adult-one");
  return {
    storage,
    familyId: FAMILY,
    now: () => new Date("2026-02-10T08:00:00Z"),
    allowlist: [{ user: "adult-one", tokenDigest: await tokenDigest(TOKEN) }],
  };
}

const get = (path: string, cookie = "") => new Request(`https://example.test${path}`, { headers: cookie ? { cookie } : {} });
const post = (path: string, body: string) =>
  new Request(`https://example.test${path}`, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });

async function sessionCookie(d: DashboardDeps, base = ""): Promise<string> {
  const response = await handleDashboard(post(`${base}/login`, `user=adult-one&token=${TOKEN}`), d, base);
  return (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

describe("access", () => {
  it("shows the login page and no data without a session", async () => {
    const response = await handleDashboard(get("/"), await deps(), "");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain('action="/login"');
    expect(body).not.toContain("Child One");
    expect(body).not.toContain("150.50");
  });

  it("gives a user that is not on the allowlist no session and no data", async () => {
    const d = await deps();
    const login = await handleDashboard(post("/login", `user=stranger&token=${TOKEN}`), d, "");
    expect(login.headers.get("set-cookie")).toBeNull();
    expect(await login.text()).toContain("The user or the token is not correct.");
    const forged = await handleDashboard(get("/", "payments_dashboard=stranger.abc"), d, "");
    expect(await forged.text()).not.toContain("Child One");
  });

  it("rejects a wrong token", async () => {
    const response = await handleDashboard(post("/login", "user=adult-one&token=wrong"), await deps(), "");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("gives no access when the allowlist is empty", async () => {
    const d = { ...(await deps()), allowlist: [] };
    const response = await handleDashboard(post("/login", `user=adult-one&token=${TOKEN}`), d, "");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("drops a session after the user leaves the allowlist", async () => {
    const d = await deps();
    const cookie = await sessionCookie(d);
    const body = await (await handleDashboard(get("/", cookie), { ...d, allowlist: [] }, "")).text();
    expect(body).not.toContain("Child One");
  });
});

describe("read view", () => {
  it("shows the Payments after login", async () => {
    const d = await deps();
    const login = await handleDashboard(post("/login", `user=adult-one&token=${TOKEN}`), d, "");
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/");
    const response = await handleDashboard(get("/", await sessionCookie(d)), d, "");
    const body = await response.text();
    expect(body).toContain("Unpaid");
    expect(body).toContain("Next due");
    expect(body).toContain("2026-02-20");
    expect(body).toContain("150.50");
    expect(body).toContain("120.00");
    expect(body).toContain("2025/2026");
    expect(body).toContain("Example &lt;Organizer&gt;");
  });

  it("shows the refund-check mark on a paid row that has the flag, read only", async () => {
    const d = await deps();
    const cookie = await sessionCookie(d);
    const before = await (await handleDashboard(get("/", cookie), d, "")).text();
    expect(before).not.toContain("Check for a refund");
    const paid = (await d.storage.listPayments(FAMILY)).find((payment) => payment.status === "paid")!;
    await d.storage.flagRefundCheck(paid.id, new Date("2026-02-09T08:00:00Z"));
    const after = await (await handleDashboard(get("/", cookie), d, "")).text();
    expect(after).toContain("Check for a refund");
    expect((await d.storage.listPayments(FAMILY)).find((payment) => payment.id === paid.id)?.status).toBe("paid");
  });

  it("uses the mount prefix for links and the cookie path", async () => {
    const d = await deps();
    const response = await handleDashboard(post("/pay/login", `user=adult-one&token=${TOKEN}`), d, "/pay");
    expect(response.headers.get("location")).toBe("/pay/");
    expect(response.headers.get("set-cookie")).toContain("Path=/pay");
    const page = await handleDashboard(get("/pay/", await sessionCookie(d, "/pay")), d, "/pay");
    expect(await page.text()).toContain('action="/pay/logout"');
  });

  it("signs out", async () => {
    const response = await handleDashboard(post("/logout", ""), await deps(), "");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("location")).toBe("/login");
  });

  it("answers 404 for an unknown route", async () => {
    expect((await handleDashboard(get("/nothing"), await deps(), "")).status).toBe(404);
  });

  it("shows an empty note when there are no Payments", async () => {
    const d = await deps();
    const empty = { ...d, storage: createMemoryStorage({ configs: [config] }) };
    const body = await (await handleDashboard(get("/", await sessionCookie(d)), empty, "")).text();
    expect(body).toContain("Nothing to show.");
  });
});

describe("Paid and Skip buttons", () => {
  const pendingId = async (d: DashboardDeps) =>
    (await d.storage.listPayments(FAMILY)).find((payment) => payment.status === "pending")?.id ?? "";

  it("shows the buttons on pending Payments only", async () => {
    const d = await deps();
    const body = await (await handleDashboard(get("/", await sessionCookie(d)), d, "")).text();
    expect(body).toContain(`/payments/${await pendingId(d)}/paid`);
    expect(body).toContain(`/payments/${await pendingId(d)}/skip`);
    expect(body.match(/\/payments\//g)).toHaveLength(2);
  });

  const press = (path: string, cookie: string) =>
    new Request(`https://example.test${path}`, { method: "POST", headers: cookie ? { cookie } : {} });

  it("sets the status and decided_by to the dashboard user", async () => {
    const d = await deps();
    const id = await pendingId(d);
    const response = await handleDashboard(press(`/payments/${id}/skip`, await sessionCookie(d)), d, "");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    const payment = (await d.storage.listPayments(FAMILY)).find((p) => p.id === id);
    expect(payment?.status).toBe("skipped");
    expect(payment?.decidedBy).toBe("adult-one");
  });

  it("does not change the status again on a repeated press", async () => {
    const d = await deps();
    const id = await pendingId(d);
    const cookie = await sessionCookie(d);
    await handleDashboard(press(`/payments/${id}/paid`, cookie), d, "");
    const again = await handleDashboard(press(`/payments/${id}/skip`, cookie), d, "");
    expect(again.status).toBe(303);
    const payment = (await d.storage.listPayments(FAMILY)).find((p) => p.id === id);
    expect(payment?.status).toBe("paid");
  });

  it("changes nothing without a session", async () => {
    const d = await deps();
    const id = await pendingId(d);
    const response = await handleDashboard(press(`/payments/${id}/paid`, ""), d, "");
    expect(await response.text()).toContain('action="/login"');
    expect((await d.storage.listPayments(FAMILY)).find((p) => p.id === id)?.status).toBe("pending");
  });

  it("gives a redirect for an unknown Payment and keeps the base path", async () => {
    const d = await deps();
    const response = await handleDashboard(press("/app/payments/unknown/paid", await sessionCookie(d, "/app")), d, "/app");
    expect(response.headers.get("location")).toBe("/app/");
  });

  const eventTypes = async (d: DashboardDeps) =>
    (await d.storage.listEvents(FAMILY, { kinds: ["payment"] })).map((event) => event.eventType);

  it("appends PaymentDue and the decision once for a Payment without a head", async () => {
    const d = await deps();
    const id = await pendingId(d);
    const cookie = await sessionCookie(d);
    await handleDashboard(press(`/payments/${id}/paid`, cookie), d, "");
    await handleDashboard(press(`/payments/${id}/skip`, cookie), d, "");
    expect(await eventTypes(d)).toEqual(["PaymentDue", "PaymentPaid"]);
  });

  it("appends nothing without a session", async () => {
    const d = await deps();
    await handleDashboard(press(`/payments/${await pendingId(d)}/paid`, ""), d, "");
    expect(await eventTypes(d)).toEqual([]);
  });
});
