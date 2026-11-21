import { describe, expect, it } from "vitest";
import { answerSkeleton, jsonShape, jsonValueShape, keyMark } from "./billing-redact-json.ts";

const shapeOf = (value: unknown): unknown => jsonValueShape(value);

describe("keyMark", () => {
  it("keeps plain keys and masks dates, digit runs, spaced and long keys", () => {
    expect(keyMark("paymentPlan")).toBe("paymentPlan");
    expect(keyMark("2025-10")).toBe("<date>");
    expect(keyMark("2025-10-03")).toBe("<date>");
    expect(keyMark("123")).toBe("<n>");
    expect(keyMark("item42")).toBe("item<n>");
    expect(keyMark("Example Name")).toBe("<key>");
    expect(keyMark("x".repeat(41))).toBe("<key>");
    expect(keyMark("parent@example.org")).toBe("<key>");
  });
});

describe("jsonValueShape", () => {
  it("marks strings by type", () => {
    expect(
      shapeOf({
        a: "",
        b: "2025-10-03",
        c: "2025-10-03T10:00:00Z",
        d: "120,50 zł",
        e: "42",
        f: "parent@example.org",
        g: "Example Person",
      }),
    ).toEqual({ a: "<empty>", b: "<date>", c: "<date>", d: "<amount>", e: "<number>", f: "<email>", g: "<text>" });
  });

  it("marks numbers, keeps booleans and null", () => {
    expect(shapeOf({ amount: 2, total: 1234.5, ok: true, none: null })).toEqual({
      amount: "<number>",
      total: "<number>",
      ok: true,
      none: null,
    });
  });

  it("keeps small integers under a code-like key only", () => {
    expect(shapeOf({ status: 2, paymentState: 0, kind: 9, mode: 10, flag: 1, cancel: 1.5, type: [1, 2] })).toEqual({
      status: 2,
      paymentState: 0,
      kind: 9,
      mode: "<number>",
      flag: "<number>",
      cancel: "<number>",
      type: { $length: 2, $item: { $either: [1, 2] } },
    });
  });

  it("masks keys that are dates or digit runs and merges the values", () => {
    expect(shapeOf({ "2025-10": { v: 1 }, "2025-11": { w: "x" }, "123": 5 })).toEqual({
      "<date>": { v: "<number>", w: "<text>" },
      "<n>": "<number>",
    });
  });

  it("gives the length and the merged item shape of an array", () => {
    expect(shapeOf({ rows: [{ a: 1 }, { b: "x" }, { a: 2, c: null }] })).toEqual({
      rows: { $length: 3, $item: { a: "<number>", b: "<text>", c: null } },
    });
    expect(shapeOf({ rows: [] })).toEqual({ rows: { $length: 0 } });
  });

  it("reads only the first 20 items", () => {
    const rows = [...Array.from({ length: 20 }, () => ({ a: 1 })), { late: 1 }];
    expect(shapeOf(rows)).toEqual({ $length: 21, $item: { a: "<number>" } });
  });

  it("lists the different shapes of a mixed place", () => {
    expect(shapeOf({ v: [{ a: 1 }, null, "x", [1]] })).toEqual({
      v: {
        $length: 4,
        $item: {
          $either: [{ a: "<number>" }, { $length: 1, $item: "<number>" }, null, "<text>"],
        },
      },
    });
  });

  it("stops at depth 8", () => {
    let value: unknown = "x";
    for (let i = 0; i < 10; i += 1) value = { n: value };
    let shape = shapeOf(value) as Record<string, unknown>;
    for (let i = 0; i < 8; i += 1) shape = shape.n as Record<string, unknown>;
    expect(shape).toEqual({ n: "<deep>" });
  });
});

describe("jsonShape", () => {
  it("gives a compact JSON text without the values", () => {
    const text = JSON.stringify({ email: "parent@example.org", name: "Example Person", id: 123456, amount: "99,00 zł" });
    const shape = jsonShape(text) as string;
    expect(JSON.parse(shape)).toEqual({ email: "<email>", name: "<text>", id: "<number>", amount: "<amount>" });
    for (const fake of ["parent@example.org", "Example Person", "123456", "99,00"]) expect(shape).not.toContain(fake);
  });

  it("gives null for text that is not a JSON object or array", () => {
    expect(jsonShape("<html></html>")).toBeNull();
    expect(jsonShape("{broken")).toBeNull();
    expect(jsonShape("42")).toBeNull();
  });

  it("cuts the output after 200 KB", () => {
    const wide = Object.fromEntries(Array.from({ length: 30_000 }, (_, i) => [`key${String.fromCharCode(97 + (i % 26))}${"b".repeat(i % 7)}x${"q".repeat(Math.floor(i / 26) % 40)}`, "t"]));
    const shape = jsonShape(JSON.stringify(wide)) as string;
    expect(shape.endsWith("<truncated>")).toBe(true);
    expect(shape.length).toBe(200_000 + "<truncated>".length);
  });
});

describe("answerSkeleton", () => {
  it("uses the JSON shape, the HTML skeleton or a text mark", () => {
    expect(answerSkeleton('{"a":"x"}')).toBe('{"a":"<text>"}');
    expect(answerSkeleton("<body><p>Płatności</p></body>")).toBe("<p>Płatności</p>");
    expect(answerSkeleton("plain words")).toBe("<text>");
  });
});
