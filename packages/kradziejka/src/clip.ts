/** Shortens text so a stored turn or a Jev state stays small. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max);
}

/** Splits a Telegram message that is longer than the Bot API limit. */
export function splitText(text: string, limit = 3500): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  for (let index = 0; index < text.length; index += limit) parts.push(text.slice(index, index + limit));
  return parts;
}
