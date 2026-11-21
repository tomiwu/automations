import * as cheerio from "cheerio";

/**
 * The few fields of a parsed node that the skeleton reads. Local types, so the code does not depend on the
 * `domhandler` types (not a declared dependency; the Kody publish check resolves them differently).
 */
interface AnyNode {
  type: string;
  data?: string;
  name?: string;
  attribs?: Record<string, string>;
  children?: AnyNode[];
}
type Element = AnyNode & { name: string };

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
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const DATE_MARK =
  /^\d{4}-\d{2}-\d{2}$|^\d{1,2}\.\d{1,2}\.\d{4}$|^\d{1,2} [a-ząćęłńóśźż]+ \d{4}$/i;
const AMOUNT_MARK = /^-?\d[\d\s]*(?:[,.]\d+)?\s*(?:zł|PLN)$/i;
const NUMBER_MARK = /^-?\d+(?:[,.]\d+)?$/;
const URL_ATTRS = new Set(["href", "action", "src", "data-url"]);
const JSON_SCRIPT = new Set(["application/json", "application/ld+json"]);
const KEEP_ATTR_VALUE = new Set(["role", "type"]);
/** These values are kept, but a record id in them (digits, a UUID, a long token) is masked. */
const MASKED_ATTR_VALUE = new Set(["class", "id", "name", "for"]);
const STIMULUS_CODE = new Set(["data-controller", "data-action"]);
const PATH_IN_TEXT = /https?:\/\/\S+|\/[^\s)]+/g;
const VOID_TAG = new Set(["meta", "img", "input", "br", "hr", "link"]);
const SKIP_NODE = new Set(["comment", "cdata"]);
const ELEMENT_NODE = new Set(["script", "tag"]);
const STIMULUS_VALUE_SUFFIX = /-(?:url|path|src)-value$/;

/** A long word is a token only when it has a digit, so long class names like `client-panel-billing-table` stay. */
const tokenMark = (word: string): string => (/\d/.test(word) ? "<id>" : word);

/** Masks record ids in a value: a UUID or a long token with a digit becomes `<id>`, a digit run becomes `<n>`. */
export function maskIds(segment: string): string {
  return segment
    .replace(UUID, "<id>")
    .replace(LONG_TOKEN, tokenMark)
    .replace(/\d+/g, "<n>");
}

function maskEmails(text: string): string {
  return text.replace(EMAIL, "<email>");
}

function fileNameMark(file: string): string {
  const match = file.match(/^(.*)\.([A-Za-z0-9]+)$/);
  if (!match) return "<file>";
  return `<file>.${match[2]}`;
}

/** Redacts a file path: directory segments are masked; the file name becomes `<file>.<ext>`. */
function redactFilePath(raw: string): string {
  try {
    const url = new URL(raw, "https://example.invalid");
    const parts = url.pathname.split("/");
    const last = parts.pop() ?? "";
    const dir = parts.map((part) => (part === "" ? "" : maskIds(part))).join("/");
    const file = fileNameMark(last);
    return dir === "" ? `/${file}` : `${dir}/${file}`;
  } catch {
    return "<text>";
  }
}

function redactSrcset(raw: string): string {
  return raw
    .split(",")
    .map((piece) => {
      const trimmed = piece.trim();
      const space = trimmed.indexOf(" ");
      const url = space === -1 ? trimmed : trimmed.slice(0, space);
      const rest = space === -1 ? "" : trimmed.slice(space);
      return `${redactFilePath(url)}${rest}`;
    })
    .join(", ");
}

/** Redacts a URL for the skeleton: path segments, query key names only, no fragment. */
export function redactUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase().startsWith("mailto:")) return "mailto:<email>";
  if (trimmed.toLowerCase().startsWith("tel:")) return "tel:<n>";
  try {
    const url = new URL(raw, "https://example.invalid");
    const path = url.pathname
      .split("/")
      .map((part) => (part === "" ? "" : maskIds(part)))
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

function scalarText(text: string): string | null {
  if (!text) return "<empty>";
  if (text === "true" || text === "false") return "<bool>";
  return null;
}

function stringMark(raw: string): string {
  const text = maskEmails(raw.trim());
  const scalar = scalarText(text);
  if (scalar) return scalar;
  if (LABEL_ALLOWLIST.has(text)) return text;
  if (text.includes("<email>")) return "<email>";
  return valueMark(text);
}

function isStimulusCode(name: string): boolean {
  if (STIMULUS_CODE.has(name)) return true;
  return name.endsWith("-target");
}

function isPathOrUrl(value: string): boolean {
  return /^(\/|https?:)/.test(value) || (value.includes("=") && value.includes("?"));
}

function isUrlLike(name: string, value: string): boolean {
  if (URL_ATTRS.has(name)) return true;
  return name.startsWith("data-") && /^(\/|https?:)/.test(value);
}

function stimulusValueMark(value: string): string {
  return isPathOrUrl(value) ? redactUrl(value) : stringMark(value);
}

function maskedNameValue(name: string, value: string): string | null {
  if (isStimulusCode(name)) return maskIds(value);
  if (name.endsWith("-value")) return stimulusValueMark(value);
  if (KEEP_ATTR_VALUE.has(name)) return value;
  if (MASKED_ATTR_VALUE.has(name)) return maskIds(value);
  return null;
}

function imgAttrValue(el: Element, name: string, value: string): string | null {
  if (el.name !== "img") return null;
  if (name === "srcset") return redactSrcset(value);
  if (name === "src") return redactFilePath(value);
  return null;
}

function attrValue(el: Element, name: string, value: string): string {
  const masked = maskedNameValue(name, value);
  if (masked !== null) return masked;
  const img = imgAttrValue(el, name, value);
  if (img !== null) return img;
  if (isUrlLike(name, value)) return redactUrl(value);
  return tryJsonShape(value) ?? stringMark(value);
}

function formatAttrs(el: Element): string {
  if (!el.attribs) return "";
  return Object.entries(el.attribs)
    .map(([name, value]) => {
      const text = String(value);
      const icon = el.name === "link" && name === "href" && (el.attribs?.rel ?? "").includes("icon");
      const redacted = icon ? redactFilePath(text) : attrValue(el, name, text);
      return ` ${name}="${redacted}"`;
    })
    .join("");
}

function textContent(el: Element): string {
  return el.children?.map((child) => (child.type === "text" ? (child.data ?? "") : "")).join("") ?? "";
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
  const text = node.data ?? "";
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

export interface HeadSummary {
  scripts: string[];
  modulepreload: string[];
  preloadScripts: string[];
  importmap?: { keys: string[]; paths: Record<string, string> };
}

/** Builds a redacted summary of the document head (scripts and preloads only, no inline text). */
export function headSummary(html: string): HeadSummary {
  const $ = cheerio.load(html);
  const scripts = $("head script[src]")
    .map((_, el) => redactUrl($(el).attr("src") ?? ""))
    .get();
  const modulepreload = $("head link[rel=modulepreload]")
    .map((_, el) => redactUrl($(el).attr("href") ?? ""))
    .get();
  const preloadScripts = $('head link[rel="preload"][as="script"]')
    .map((_, el) => redactUrl($(el).attr("href") ?? ""))
    .get();
  const importmapRaw = $('head script[type="importmap"]').first().text();
  let importmap: HeadSummary["importmap"];
  if (importmapRaw.trim()) {
    try {
      const parsed = JSON.parse(importmapRaw) as { imports?: Record<string, string> };
      const imports = parsed.imports ?? {};
      importmap = {
        keys: Object.keys(imports),
        paths: Object.fromEntries(Object.entries(imports).map(([key, path]) => [key, redactUrl(path)])),
      };
    } catch {
      importmap = { keys: [], paths: {} };
    }
  }
  return { scripts, modulepreload, preloadScripts, importmap };
}

/** Redacts response text as JSON shape, HTML body skeleton, or a short text mark. */
function skeletonByType(text: string, type: string): string {
  if (type.includes("json")) return tryJsonShape(text) ?? "<text>";
  if (type.includes("html") || text.includes("<")) return bodySkeleton(text);
  return "<text>";
}

export function responseSkeleton(text: string, contentType: string): string {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return skeletonByType(text, type);
}

/** Redacts every URL and path in a text, for example in an error message. */
export function redactPaths(text: string): string {
  return maskEmails(text).replace(PATH_IN_TEXT, (path) => redactUrl(path));
}

/** Builds a redacted skeleton of the document body. It has no family data and no secrets. */
export function bodySkeleton(html: string): string {
  const children = (cheerio.load(html)("body").get(0) as unknown as AnyNode | undefined)?.children;
  return children?.length ? buildSkeleton(children) : "";
}

/** True when an attribute name can hold a settlements upcoming address from markup. */
export function isUpcomingMarkupAttr(name: string): boolean {
  return STIMULUS_VALUE_SUFFIX.test(name) || URL_ATTRS.has(name);
}