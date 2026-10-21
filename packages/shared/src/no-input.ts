function isBlankText(value: unknown): boolean {
  return typeof value === "string" && value.trim() === "";
}

function isEmptyContainer(value: unknown): boolean {
  if (Array.isArray(value)) return value.length === 0;
  return typeof value === "object" && value !== null && Object.keys(value).length === 0;
}

/** Returns true if a value holds no input: null, undefined, blank text, an empty array or an empty object. */
export function hasNoInput(value: unknown): boolean {
  return value === undefined || value === null || isBlankText(value) || isEmptyContainer(value);
}
