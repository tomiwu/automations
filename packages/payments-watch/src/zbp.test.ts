import jsQR from "jsqr";
import QRCode from "qrcode";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { buildZbpQr, buildZbpText, cleanField, isValidNip, isValidNrb } from "./zbp.ts";

const NRB = "61109010140000071219812874";
const SCALE = 6;
const NIP = "5260001246";
const base = { nrb: NRB, amountGrosze: 12345, recipient: "Example Club", title: "Fee May" };

describe("isValidNrb", () => {
  it("accepts a correct checksum", () => expect(isValidNrb(NRB)).toBe(true));
  it("rejects a wrong checksum", () => expect(isValidNrb("61109010140000071219812875")).toBe(false));
  it("rejects a wrong length or letters", () => {
    expect(isValidNrb(NRB.slice(1))).toBe(false);
    expect(isValidNrb(`PL${NRB}`)).toBe(false);
  });
});

describe("isValidNip", () => {
  it("accepts a correct checksum", () => expect(isValidNip(NIP)).toBe(true));
  it("rejects a wrong checksum", () => expect(isValidNip("5260001247")).toBe(false));
  it("rejects a wrong length", () => expect(isValidNip("526000124")).toBe(false));
});

describe("cleanField", () => {
  it("truncates to the maximum", () => expect(cleanField("a".repeat(40), 20)).toBe("a".repeat(20)));
  it("keeps Polish letters", () => expect(cleanField("Zażółć gęślą", 20)).toBe("Zażółć gęślą"));
  it("replaces characters that are not allowed", () => {
    expect(cleanField("A|B*C\nD", 20)).toBe("A B C D");
  });
  it("trims after truncation", () => expect(cleanField("abc def", 4)).toBe("abc"));
});

describe("buildZbpText", () => {
  it("builds the fields in order with a padded amount", () => {
    expect(buildZbpText(base)).toBe(`|PL|${NRB}|012345|Example Club|Fee May|||`);
  });
  it("puts a valid NIP in the first field", () => {
    expect(buildZbpText({ ...base, nip: NIP }).startsWith(`${NIP}|PL|`)).toBe(true);
  });
  it("keeps an amount of more than 6 digits", () => {
    expect(buildZbpText({ ...base, amountGrosze: 12345678 }).split("|")[3]).toBe("12345678");
  });
  it("truncates the recipient to 20 and the title to 32 characters", () => {
    const fields = buildZbpText({ ...base, recipient: "r".repeat(30), title: "t".repeat(50) }).split("|");
    expect(fields[4]).toHaveLength(20);
    expect(fields[5]).toHaveLength(32);
  });
  it("rejects a bad NRB", () => {
    expect(() => buildZbpText({ ...base, nrb: "61109010140000071219812875" })).toThrow(/NRB/);
  });
  it("rejects a bad NIP", () => {
    expect(() => buildZbpText({ ...base, nip: "5260001247" })).toThrow(/NIP/);
  });
  it("rejects an amount of 0, a negative or a fractional amount", () => {
    for (const amountGrosze of [0, -5, 1.5, Number.NaN]) {
      expect(() => buildZbpText({ ...base, amountGrosze })).toThrow(/amount/);
    }
  });
  it("never exceeds 160 characters for the longest valid input", () => {
    const text = buildZbpText({
      nip: NIP,
      nrb: NRB,
      amountGrosze: Number.MAX_SAFE_INTEGER,
      recipient: "r".repeat(99),
      title: "t".repeat(99),
    });
    expect(text.length).toBeLessThanOrEqual(160);
  });
});

describe("buildZbpQr", () => {
  it("gives a PNG that decodes to the text", async () => {
    const { text, png } = await buildZbpQr({ ...base, nip: NIP, recipient: "Zażółć", title: "Opłata" });
    const image = PNG.sync.read(Buffer.from(png));
    const decoded = jsQR(new Uint8ClampedArray(image.data), image.width, image.height);
    expect(decoded?.data).toBe(text);
  });
  it("uses error correction L and a border of 4 modules", async () => {
    const { text, png } = await buildZbpQr(base);
    const image = PNG.sync.read(Buffer.from(png));
    const expected = QRCode.create(text, { errorCorrectionLevel: "L" }).modules.size;
    expect(image.width / SCALE - 8).toBe(expected);
    const dark = (x: number, y: number) => (image.data[(y * image.width + x) * 4] ?? 255) < 128;
    expect(dark(4 * SCALE, 4 * SCALE)).toBe(true);
    expect(dark(4 * SCALE - 1, 4 * SCALE - 1)).toBe(false);
  });
  it("rejects invalid input", async () => {
    await expect(buildZbpQr({ ...base, amountGrosze: 0 })).rejects.toThrow(/amount/);
  });
});
