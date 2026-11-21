/** Form-encodes text the way `URLSearchParams` does (a space becomes `+`). */
const plain = (text: string): string => new URLSearchParams({ x: text }).toString().slice(2);

const PLACEHOLDER = /\{\{\s*secret[^}]*\}\}/g;

/**
 * Encodes the fields of a form body. A Kody secret placeholder (`{{secret:NAME}}`) is kept as it is, so that Kody
 * can find it and fill in the secret at fetch time. Everything else is form-encoded.
 */
export function formBody(fields: Record<string, string>): string {
  const encode = (text: string): string => {
    let out = "";
    let last = 0;
    for (const match of text.matchAll(PLACEHOLDER)) {
      out += plain(text.slice(last, match.index)) + match[0];
      last = match.index + match[0].length;
    }
    return out + plain(text.slice(last));
  };
  return Object.entries(fields)
    .map(([name, value]) => `${encode(name)}=${encode(value)}`)
    .join("&");
}
