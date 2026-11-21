import { readFileSync } from "node:fs";
import { countFetches, fakeRuntime } from "@automations/shared";
import { describe, expect, it, vi } from "vitest";
import {
  mergeLedgerRows,
  matchLedger,
  ledgerColourOf,
  parseLedger,
  parseLedgerDate,
  readActiveNowLedger,
} from "./activenow-ledger.ts";
import { ACTIVE_NOW_BLOCK } from "@tomiwu/activities-watch";
import { createHttp } from "@tomiwu/activities-watch";

const settlements = readFileSync(new URL("./fixtures/activenow-settlements.html", import.meta.url), "utf8");
const future = readFileSync(new URL("./fixtures/activenow-settlements-table-future.html", import.meta.url), "utf8");

const TODAY = "2026-04-20";

describe("ledgerColourOf", () => {
  it("reads the pill token and mobile classes", () => {
    expect(ledgerColourOf("group rounded-full red", "")).toBe("red");
    expect(ledgerColourOf("", "font-semibold text-green-dark")).toBe("green");
    expect(ledgerColourOf("group", "other")).toBeNull();
  });
});

describe("parseLedgerDate", () => {
  it("reads a Polish date", () => {
    expect(parseLedgerDate("1 maja 2026")).toBe("2026-05-01");
  });
  it("reads DD.MM.YYYY", () => {
    expect(parseLedgerDate("15.04.2026")).toBe("2026-04-15");
  });
});

describe("parseLedger", () => {
  it("reads all desktop rows, banner and kinds", () => {
    const ledger = parseLedger(settlements);
    expect(ledger.banner).toEqual({ debt: false, debtAmount: undefined });
    expect(ledger.rows).toEqual([
      { date: "2026-04-01", title: "Monthly tuition April", amount: 15000, kind: "charge" },
      { date: "2026-04-10", title: "Bank transfer April", amount: 15000, kind: "payment" },
      { date: "2026-05-01", title: "Monthly tuition May", amount: 20000, kind: "charge" },
    ]);
  });

  it("merges future rows that are not on the index page", () => {
    const rows = mergeLedgerRows(parseLedger(settlements).rows, parseLedger(future, true).rows);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({ date: "2026-06-01", kind: "charge", amount: 20000 });
  });

  it("needs fragment mode for the table answer, which has no table target", () => {
    expect(() => parseLedger(future)).toThrow("table not found");
    expect(parseLedger(future, true).rows).toHaveLength(1);
  });

  it("reads an empty table answer as no rows", () => {
    expect(parseLedger("", true).rows).toEqual([]);
  });

  it("reads no debt when the banner has only the danger variant class", () => {
    expect(settlements).toContain("[&.danger]:border-red");
    expect(parseLedger(settlements).banner.debt).toBe(false);
  });

  it("lets the colour decide for an amount without a sign", () => {
    const unsigned = settlements.replace(/red "><p>-150 zł<\/p>/, 'red "><p>150 zł</p>').replace(">-150 zł</div>", ">150 zł</div>");
    expect(parseLedger(unsigned).rows[0]).toMatchObject({ kind: "charge", amount: 15000 });
  });

  it("does not take the desktop:hidden mobile card for a desktop row", () => {
    const ledger = parseLedger(settlements);
    expect(ledger.rows).toHaveLength(3);
  });

  it("throws when the table is missing", () => {
    expect(() => parseLedger("<p>empty</p>")).toThrow("table not found");
  });

  it("throws when the header is missing", () => {
    const bad = settlements.replace("Data</div><div>Tytuł</div><div>Kwota", "Col</div><div>Col</div><div>Col");
    expect(() => parseLedger(bad)).toThrow("table header not found");
  });

  it("throws when desktop and mobile counts differ", () => {
    const bad = settlements.replace(
      '<div class="desktop:hidden border rounded-xl p-3">\n          <div>Monthly tuition May</div>',
      "",
    );
    expect(() => parseLedger(bad)).toThrow("desktop and mobile row counts differ");
  });

  it("throws when colour and sign disagree", () => {
    const bad = settlements.replace('green "><p>150 zł</p>', 'red "><p>+150 zł</p>');
    expect(() => parseLedger(bad)).toThrow("colour and sign disagree");
  });

  it("reads a debt banner with an amount", () => {
    const debt = settlements
      .replace("rounded-xl p-4 \"", "rounded-xl p-4 danger\"")
      .replace("Brak zaległości", "1 200 zł zaległości");
    expect(parseLedger(debt).banner).toEqual({ debt: true, debtAmount: 120000 });
  });

  it("reads an ISO date in a desktop row", () => {
    const iso = settlements.replace("1 kwietnia 2026", "2026-04-01");
    expect(parseLedger(iso).rows[0]?.date).toBe("2026-04-01");
  });
});

describe("matchLedger", () => {
  const accountId = "00000000-0000-4000-8000-0000000000a1";

  it("covers oldest charges first and marks upcoming rows", () => {
    const { banner, rows } = parseLedger(settlements);
    const matched = matchLedger(rows, banner, TODAY, accountId);
    expect(matched.checked).toBe(true);
    expect(matched.openThroughToday).toBe(0);
    const april = matched.charges.find((row) => row.date === "2026-04-01");
    const may = matched.charges.find((row) => row.date === "2026-05-01");
    expect(april?.status).toBe("covered");
    expect(may?.status).toBe("upcoming");
  });

  it("covers an upcoming charge that is already paid", () => {
    const rows = [
      { date: "2026-04-01", title: "Monthly tuition April", amount: 15000, kind: "charge" as const },
      { date: "2026-04-10", title: "Bank transfer", amount: 35000, kind: "payment" as const },
      { date: "2099-05-01", title: "Monthly tuition May", amount: 20000, kind: "charge" as const },
    ];
    const matched = matchLedger(rows, { debt: false }, TODAY, accountId);
    expect(matched.charges.map((row) => row.status)).toEqual(["covered", "covered"]);
  });

  it("covers strictly oldest first: a later small charge is not covered past an open one", () => {
    const rows = [
      { date: "2026-04-01", title: "Charge A", amount: 15000, kind: "charge" as const },
      { date: "2026-04-05", title: "Charge B", amount: 5000, kind: "charge" as const },
      { date: "2026-04-10", title: "Payment", amount: 10000, kind: "payment" as const },
    ];
    const matched = matchLedger(rows, { debt: false }, TODAY, accountId);
    expect(matched.charges.map((row) => row.status)).toEqual(["open", "open"]);
  });

  it("marks a partially paid charge as open", () => {
    const rows = [
      { date: "2026-04-01", title: "Monthly tuition April", amount: 15000, kind: "charge" as const },
      { date: "2026-04-10", title: "Partial payment", amount: 5000, kind: "payment" as const },
    ];
    const matched = matchLedger(rows, { debt: false }, TODAY, accountId);
    expect(matched.charges[0]?.status).toBe("open");
    expect(matched.openThroughToday).toBe(15000);
    expect(matched.checked).toBe(false);
  });

  it("covers several charges when payments overpay", () => {
    const rows = [
      { date: "2026-04-01", title: "Charge A", amount: 5000, kind: "charge" as const },
      { date: "2026-04-05", title: "Charge B", amount: 7000, kind: "charge" as const },
      { date: "2026-04-10", title: "Large payment", amount: 20000, kind: "payment" as const },
    ];
    const matched = matchLedger(rows, { debt: false }, TODAY, accountId);
    expect(matched.charges.map((row) => row.status)).toEqual(["covered", "covered"]);
    expect(matched.openThroughToday).toBe(0);
    expect(matched.checked).toBe(true);
  });

  it("fails banner check when open debt remains", () => {
    const ledger = parseLedger(settlements);
    const rows = ledger.rows.filter((row) => row.kind === "charge" || (row.kind === "payment" && row.date !== "2026-04-10"));
    const matched = matchLedger(rows, ledger.banner, TODAY, accountId);
    expect(matched.openThroughToday).toBe(15000);
    expect(matched.checked).toBe(false);
  });

  it("checks debt banner amount", () => {
    const debtBanner = { debt: true, debtAmount: 15000 };
    const rows = parseLedger(settlements).rows.filter((row) => row.kind === "charge" || row.kind === "payment");
    const withoutPay = rows.filter((row) => !(row.kind === "payment" && row.date === "2026-04-10"));
    const matched = matchLedger(withoutPay, debtBanner, TODAY, accountId);
    expect(matched.checked).toBe(true);
    const bad = matchLedger(withoutPay, { debt: true, debtAmount: 12000 }, TODAY, accountId);
    expect(bad.checked).toBe(false);
  });
});

describe("readActiveNowLedger", () => {
  const LOGIN_FORM =
    '<form action="/users/sign_in"><input type="hidden" name="authenticity_token" value="tok" /><input name="user[email]" /><input type="password" name="user[password]" /></form>';
  const PICKER =
    '<meta name="csrf-token" content="csrf1"><a href="/role_selector/change_role?school_user_id=1"><p>Child One</p></a>';
  const PANEL = `<nav><a href="/client_panel/settlements/index">Rozliczenia</a></nav>`;

  it("sends the five ActiveNow requests on one session", async () => {
    const answers: Record<string, { status: number; body: string }> = {
      "GET /users/sign_in": { status: 200, body: LOGIN_FORM },
      "POST /users/sign_in": { status: 200, body: PICKER },
      "POST /role_selector/change_role": { status: 200, body: PANEL },
      "GET /client_panel/settlements/index": { status: 200, body: settlements },
      "GET /client_panel/settlements/table": { status: 200, body: future },
    };
    const runtime = fakeRuntime({
      secrets: { LOGIN: "u", PASS: "p" },
      respond: (input, init) => {
        const url = new URL(input);
        const key = `${init?.method ?? "GET"} ${url.pathname}`;
        const answer = answers[key] ?? { status: 404, body: "missing" };
        return new Response(answer.body, { status: answer.status });
      },
    });
    const counter = countFetches(runtime.fetch);
    const http = createHttp({ ...runtime, fetch: counter.fetch });
    const read = await readActiveNowLedger(
      http,
      "https://activenow.example.org",
      "00000000-0000-4000-8000-0000000000a1",
      { login: "u", password: "p" },
      "Child One",
      TODAY,
    );
    expect(counter.count().total).toBe(5);
    expect(read.rows).toHaveLength(4);
  });

  it("stops further reads after a block page", async () => {
    const blocked = readFileSync(new URL("../../activities-watch/src/fixtures/activenow-blocked.html", import.meta.url), "utf8");
    const runtime = fakeRuntime({
      secrets: { LOGIN: "u", PASS: "p" },
      respond: (input, init) => {
        const path = new URL(input).pathname;
        if (path === "/users/sign_in" && (init?.method ?? "GET") === "GET") return new Response(LOGIN_FORM, { status: 200 });
        if (path === "/users/sign_in" && init?.method === "POST") return new Response(PICKER, { status: 200 });
        if (path.includes("change_role")) return new Response(PANEL, { status: 200 });
        if (path.includes("settlements")) return new Response(blocked, { status: 403 });
        return new Response("missing", { status: 404 });
      },
    });
    await expect(
      readActiveNowLedger(createHttp(runtime), "https://activenow.example.org", "a1", { login: "u", password: "p" }, "Child One", TODAY),
    ).rejects.toThrow(ACTIVE_NOW_BLOCK);
  });
});