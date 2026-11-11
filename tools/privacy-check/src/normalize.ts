// Normal form of text for the private word check: lower case, no Polish diacritics, camel case split.

const MIN_TOKEN_LENGTH = 3;

export function normalize(text: string): string {
  return text
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** The words of a line. A token has 3 or more characters and one letter or more. */
export function tokens(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && /[a-z]/.test(token));
}

/** Every sequence of 1 to `maxWords` tokens, joined with one space. */
export function phrases(words: string[], maxWords: number): string[] {
  const result: string[] = [];
  for (let start = 0; start < words.length; start += 1) {
    for (let end = start + 1; end <= Math.min(words.length, start + maxWords); end += 1) {
      result.push(words.slice(start, end).join(" "));
    }
  }
  return result;
}
