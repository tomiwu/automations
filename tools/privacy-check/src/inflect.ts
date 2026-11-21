const A_ENDINGS = ["a", "y", "i", "e", "o", "u", "ie", "om", "ami", "ach"];
const CONSONANT_ENDINGS = ["", "a", "u", "owi", "em", "iem", "ie", "e", "y", "i", "owie", "ow", "om", "ami", "ach"];
const VOWEL_ENDINGS = ["a", "u", "owi", "em", "iem", "ie", "ego", "emu", "ym", "im"];
const SOFT_STEMS: Array<[RegExp, string]> = [
  [/k$/, "ce"],
  [/g$/, "dze"],
  [/r$/, "rze"],
  [/t$/, "cie"],
  [/d$/, "dzie"],
  [/l$/, "le"],
  [/i$/, "ii"],
];
const MIN_FORM_LENGTH = 3;

const withEndings = (stem: string, endings: string[]) => endings.map((ending) => stem + ending);

function softForms(stem: string): string[] {
  return SOFT_STEMS.filter(([pattern]) => pattern.test(stem)).map(([pattern, soft]) => stem.replace(pattern, soft));
}

function consonantForms(word: string): string[] {
  const forms = withEndings(word, CONSONANT_ENDINGS);
  return word.endsWith("ek") ? [...forms, ...withEndings(`${word.slice(0, -2)}k`, CONSONANT_ENDINGS)] : forms;
}

function rawForms(word: string): string[] {
  const stem = word.slice(0, -1);
  if (word.endsWith("a")) return [...withEndings(stem, A_ENDINGS), ...softForms(stem)];
  if (/[eiouy]$/.test(word)) return withEndings(stem, VOWEL_ENDINGS);
  return consonantForms(word);
}

export function inflectedForms(word: string): string[] {
  return [...new Set([word, ...rawForms(word)])].filter((form) => form.length >= MIN_FORM_LENGTH);
}
