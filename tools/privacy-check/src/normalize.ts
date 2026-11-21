const MIN_TOKEN_LENGTH = 3;

export function normalize(text: string): string {
  return text
    .replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .replace(/ł/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function tokens(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= MIN_TOKEN_LENGTH && /[a-z]/.test(token));
}

export function phrases(words: string[], maxWords: number): string[] {
  const result: string[] = [];
  for (let start = 0; start < words.length; start += 1) {
    for (let end = start + 1; end <= Math.min(words.length, start + maxWords); end += 1) {
      result.push(words.slice(start, end).join(" "));
    }
  }
  return result;
}
