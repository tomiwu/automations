import { isValidNip, isValidNrb } from "@automations/shared";
import { create as createQr } from "qrcode/lib/core/qrcode.js";
import { encodeGrayPng } from "./png.ts";

export { isValidNip, isValidNrb };

export interface ZbpInput {
  nip?: string;
  nrb: string;
  amountGrosze: number;
  recipient: string;
  title: string;
}

export interface ZbpQr {
  text: string;
  png: Uint8Array;
}

const RECIPIENT_MAX = 20;
const TITLE_MAX = 32;
const TEXT_MAX = 160;
const AMOUNT_MIN_DIGITS = 6;
const QR_MARGIN_MODULES = 4;
const QR_SCALE = 6;
const BLACK = 0;
const WHITE = 255;
const DISALLOWED = /[^A-Za-z0-9ąćęłńóśźżĄĆĘŁŃÓŚŹŻ .,\-/():+?']/g;

export function cleanField(value: string, max: number): string {
  return value.replace(DISALLOWED, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

function formatAmount(amountGrosze: number): string {
  if (!Number.isSafeInteger(amountGrosze) || amountGrosze <= 0) {
    throw new Error("ZBP amount must be a positive whole number of grosze.");
  }
  return String(amountGrosze).padStart(AMOUNT_MIN_DIGITS, "0");
}

function checkedNip(nip: string): string {
  if (nip !== "" && !isValidNip(nip)) throw new Error("ZBP NIP is not valid.");
  return nip;
}

export function buildZbpText(input: ZbpInput): string {
  const nip = checkedNip(input.nip ?? "");
  if (!isValidNrb(input.nrb)) throw new Error("ZBP NRB is not valid.");
  const amount = formatAmount(input.amountGrosze);
  const recipient = cleanField(input.recipient, RECIPIENT_MAX);
  const title = cleanField(input.title, TITLE_MAX);
  const text = [nip, "PL", input.nrb, amount, recipient, title, "", "", ""].join("|");
  if (text.length > TEXT_MAX) throw new Error(`ZBP text is longer than ${TEXT_MAX} characters.`);
  return text;
}

function isDark(modules: { size: number; get(row: number, col: number): number }, x: number, y: number): boolean {
  const row = Math.floor(y / QR_SCALE) - QR_MARGIN_MODULES;
  const col = Math.floor(x / QR_SCALE) - QR_MARGIN_MODULES;
  const inside = row >= 0 && col >= 0 && row < modules.size && col < modules.size;
  return inside && Boolean(modules.get(row, col));
}

function renderPixels(text: string): { size: number; pixels: Uint8Array } {
  const { modules } = createQr(text, { errorCorrectionLevel: "L" });
  const size = (modules.size + 2 * QR_MARGIN_MODULES) * QR_SCALE;
  const pixels = Uint8Array.from({ length: size * size }, (_, i) =>
    isDark(modules, i % size, Math.floor(i / size)) ? BLACK : WHITE,
  );
  return { size, pixels };
}

export async function buildZbpQr(input: ZbpInput): Promise<ZbpQr> {
  const text = buildZbpText(input);
  const { size, pixels } = renderPixels(text);
  return { text, png: await encodeGrayPng(size, size, pixels) };
}
