import { DATE_MARK, bodySkeleton, maskEmails, valueMark } from "./activenow-billing-redact.ts";

/**
 * The shape of a JSON answer. It keeps the keys and the types and drops every value: strings become a type
 * mark, numbers become `<number>`. Only small integers under a code-like key stay (they are codes, not data).
 */

const MAX_DEPTH = 8;
const ITEM_SAMPLE = 20;
const OUTPUT_LIMIT = 200_000;
const MAX_KEY_LENGTH = 40;
const CODE_KEY = /status|state|paid|type|cancel|settled|active|kind|mode/i;
const KEY_DATE = /^\d{4}-\d{2}(?:-\d{2})?$/;
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/;

type Shape = unknown;
type ObjectValue = Record<string, unknown>;

const isObject = (value: unknown): value is ObjectValue =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isScalar = (value: unknown): boolean => typeof value !== "object" || value === null;

/** The key as it shows in the shape: a date, a digit run or a long or spaced key is masked. */
export function keyMark(key: string): string {
  if (DATE_MARK.test(key) || KEY_DATE.test(key)) return "<date>";
  if (key.length > MAX_KEY_LENGTH || /[\s@]/.test(key)) return "<key>";
  return key.replace(/\d+/g, "<n>");
}

function stringShape(raw: string): string {
  const text = maskEmails(raw.trim());
  if (!text) return "<empty>";
  if (text.includes("<email>")) return "<email>";
  if (ISO_DATE_TIME.test(text)) return "<date>";
  return valueMark(text);
}

function numberShape(value: number, key: string): number | string {
  const code = Number.isInteger(value) && value >= 0 && value <= 9 && CODE_KEY.test(key);
  return code ? value : "<number>";
}

function scalarShape(value: unknown, key: string): Shape {
  if (typeof value === "string") return stringShape(value);
  if (typeof value === "number") return numberShape(value, key);
  return value;
}

function objectsShape(objects: ObjectValue[], depth: number): Shape | undefined {
  if (objects.length === 0) return undefined;
  const fields = new Map<string, { raw: string; values: unknown[] }>();
  for (const object of objects) {
    for (const [raw, value] of Object.entries(object)) {
      const mark = keyMark(raw);
      const field = fields.get(mark) ?? { raw, values: [] };
      field.values.push(value);
      fields.set(mark, field);
    }
  }
  const entries = [...fields].map(([mark, field]) => [mark, shapeValues(field.values, field.raw, depth + 1)]);
  return Object.fromEntries(entries);
}

function arraysShape(arrays: unknown[][], key: string, depth: number): Shape | undefined {
  if (arrays.length === 0) return undefined;
  const $length = Math.max(...arrays.map((array) => array.length));
  const items = arrays.flatMap((array) => array.slice(0, ITEM_SAMPLE));
  return items.length === 0 ? { $length } : { $length, $item: shapeValues(items, key, depth + 1) };
}

function scalarShapes(values: unknown[], key: string): Shape[] {
  const shapes = new Map(
    values.map((value) => {
      const shape = scalarShape(value, key);
      return [JSON.stringify(shape), shape];
    }),
  );
  return [...shapes.values()];
}

/** The shape of all values at one place. Objects merge their keys, arrays merge their items. */
function shapeValues(values: unknown[], key: string, depth: number): Shape {
  if (depth > MAX_DEPTH) return "<deep>";
  const parts = [
    objectsShape(values.filter(isObject), depth),
    arraysShape(values.filter(Array.isArray), key, depth),
    ...scalarShapes(values.filter(isScalar), key),
  ].filter((part) => part !== undefined);
  return parts.length === 1 ? parts[0] : { $either: parts };
}

/** The shape of a parsed JSON value. */
export function jsonValueShape(value: unknown): Shape {
  return shapeValues([value], "", 0);
}

/** The shape of a JSON text as a compact JSON text, cut after 200 KB. It gives null when the text is not a JSON object or array. */
export function jsonShape(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const shape = JSON.stringify(jsonValueShape(JSON.parse(trimmed)));
    return shape.length > OUTPUT_LIMIT ? `${shape.slice(0, OUTPUT_LIMIT)}<truncated>` : shape;
  } catch {
    return null;
  }
}

/** The redacted shape of an answer: JSON shape, HTML body skeleton, or a text mark. */
export function answerSkeleton(text: string): string {
  const json = jsonShape(text);
  if (json !== null) return json;
  return text.includes("<") ? bodySkeleton(text) : "<text>";
}
