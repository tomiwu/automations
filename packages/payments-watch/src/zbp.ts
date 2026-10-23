import { isValidNip, isValidNrb } from "@automations/shared";
import QRCode from "qrcode";

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
  png: Buffer;
}

const RECIPIENT_MAX = 20;
const TITLE_MAX = 32;
const TEXT_MAX = 160;
const AMOUNT_MIN_DIGITS = 6;
const QR_MARGIN_MODULES = 4;
const QR_SCALE = 6;
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

export async function buildZbpQr(input: ZbpInput): Promise<ZbpQr> {
  const text = buildZbpText(input);
  const png = await QRCode.toBuffer(text, {
    type: "png",
    errorCorrectionLevel: "L",
    margin: QR_MARGIN_MODULES,
    scale: QR_SCALE,
  });
  return { text, png };
}
