import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";

export const LABEL_ALLOWLIST = new Set([
  "Rozliczenia",
  "Data",
  "Tytuł",
  "Kwota",
  "Status",
  "Termin",
  "Saldo",
  "Zaległości",
  "zaległości",
  "Zapłać",
  "Zapłać online",
  "Opłacone",
  "Opłacono",
  "Nieopłacone",
  "Do zapłaty",
  "Wpłata",
  "Nadpłata",
  "Pokaż nadchodzące",
  "Brak",
  "Razem",
  "Suma",
  "Szczegóły",
  "Faktura",
  "Paragon",
]);

const BODY_LIMIT = 200_000;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const LONG_TOKEN = /\b[A-Za-z0-9+/=_-]{24,}\b/g;
const DATE_MARK =
  /^\d{4}-\d{2}-\d{2}$|^\d{1,2}\.\d{1,2}\.\d{4}$|^\d{1,2} [a-ząćęłńóśźż]+ \d{4}$/i;
const AMOUNT_MARK = /^-?\d[\d\s]*(?:[,.]\d+)?\s*(?:zł|PLN)$/i;
const NUMBER_MARK = /^-?\d+(?:[,.]\d+)?$/;
const URL_ATTRS = new Set(["href", "action", "src", "data-url"]);
const JSON_SCRIPT = new Set(["application/json", "application/ld+json"]);
const KEEP_ATTR_VALUE = new Set(["class", "id", "role", "type", "name"]);
const VOID_TAG = new Set(["meta", "img", "input", "br", "hr", "link"]);
const SKIP_NODE = new Set(["comment", "cdata"]);
const ELEMENT_NODE = new Set(["script", "tag"]);

function redactPathSegment(segment: string): string {
  return segment
    .replace(UUID, "<id>")
    .replace(LONG_TOKEN, "<id>")
    .replace(/\d+/g, "<n>");
}

/** Redacts a URL for the skeleton: path segments, query key names only, no fragment. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw, "https://example.invalid");
    const path = url.pathname
      .split("/")
      .map((part) => (part === "" ? "" : redactPathSegment(part)))
      .join("/");
    const keys = [...url.searchParams.keys()];
    const query = keys.length === 0 ? "" : `?${keys.join("&")}`;
    return `${path}${query}`;
  } catch {
    return "<text>";
  }
}

function jsonObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).map(([key, leaf]) => [key, jsonLeaf(leaf)]));
}

function jsonScalar(value: unknown): unknown {
  if (value === null) return "<empty>";
  if (typeof value === "boolean") return "<bool>";
  if (typeof value === "number") return "<number>";
  if (typeof value === "string") return stringMark(value);
  return "<text>";
}

function jsonLeaf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonLeaf);
  if (value !== null && typeof value === "object") return jsonObject(value as Record<string, unknown>);
  return jsonScalar(value);
}

function tryJsonShape(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    return JSON.stringify(jsonLeaf(JSON.parse(trimmed)));
  } catch {
    return null;
  }
}

function valueMark(text: string): string {
  if (DATE_MARK.test(text)) return "<date>";
  if (AMOUNT_MARK.test(text)) return "<amount>";
  if (NUMBER_MARK.test(text)) return "<number>";
  return "<text>";
}

function stringMark(raw: string): string {
  const text = raw.trim();
  if (text === "") return "<empty>";
  if (text === "true" || text === "false") return "<bool>";
  if (LABEL_ALLOWLIST.has(text)) return text;
  return valueMark(text);
}

function isUrlLike(name: string, value: string): boolean {
  if (URL_ATTRS.has(name)) return true;
  return name.startsWith("data-") && /^(\/|https?:)/.test(value);
}

function attrValue(name: string, value: string): string {
  if (KEEP_ATTR_VALUE.has(name)) return value;
  if (isUrlLike(name, value)) return redactUrl(value);
  const json = tryJsonShape(value);
  if (json !== null) return json;
  return stringMark(value);
}

function formatAttrs(el: Element): string {
  if (!el.attribs) return "";
  return Object.entries(el.attribs).map(([name, value]) => ` ${name}="${attrValue(name, value)}"`).join("");
}

function textContent(el: Element): string {
  return el.children?.map((child) => (child.type === "text" ? child.data : "")).join("") ?? "";
}

function scriptSkeleton(el: Element): string {
  const type = el.attribs?.type ?? "";
  if (el.attribs?.src) return `<script${formatAttrs(el)}></script>`;
  if (JSON_SCRIPT.has(type)) return `<script type="${type}">${tryJsonShape(textContent(el)) ?? "<text>"}</script>`;
  return "<script></script>";
}

function pushPart(parts: string[], size: number, value: string): number {
  parts.push(value);
  return size + value.length;
}

function walkText(node: AnyNode, parts: string[], size: number): number {
  const text = (node as { data: string }).data;
  if (!text.trim()) return size;
  return pushPart(parts, size, stringMark(text));
}

function walkTag(el: Element, parts: string[], size: number): number {
  let next = pushPart(parts, size, `<${el.name}${formatAttrs(el)}>`);
  if (VOID_TAG.has(el.name)) return next;
  for (const child of el.children ?? []) {
    next = walk(child, parts, next);
    if (next >= BODY_LIMIT) return next;
  }
  return pushPart(parts, next, `</${el.name}>`);
}

function walkNode(node: AnyNode, parts: string[], size: number): number {
  if (node.type === "script") return pushPart(parts, size, scriptSkeleton(node as Element));
  const el = node as Element;
  if (el.name === "style" || el.name === "svg") return size;
  return walkTag(el, parts, size);
}

function walk(node: AnyNode, parts: string[], size: number): number {
  if (SKIP_NODE.has(node.type)) return size;
  if (ELEMENT_NODE.has(node.type)) return walkNode(node, parts, size);
  if (node.type === "text") return walkText(node, parts, size);
  return size;
}

function buildSkeleton(children: readonly AnyNode[]): string {
  const parts: string[] = [];
  let size = 0;
  for (const child of children) {
    size = walk(child, parts, size);
    if (size >= BODY_LIMIT) break;
  }
  const skeleton = parts.join("");
  return skeleton.length > BODY_LIMIT ? `${skeleton.slice(0, BODY_LIMIT)}<cut>` : skeleton;
}

/** Builds a redacted skeleton of the document body. It has no family data and no secrets. */
export function bodySkeleton(html: string): string {
  const children = cheerio.load(html)("body").get(0)?.children;
  return children?.length ? buildSkeleton(children) : "";
}