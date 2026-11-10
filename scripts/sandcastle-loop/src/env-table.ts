/** Drift check between the `LOOP_*` names that the loop reads and the env table of the README. */

const ENV_NAME = /\bLOOP_[A-Z0-9_]*[A-Z0-9]\b/g;

/** All `LOOP_*` names in the given source texts, sorted and unique. */
export function envNamesInCode(texts: readonly string[]): string[] {
  const names = new Set<string>();
  for (const text of texts) for (const name of text.match(ENV_NAME) ?? []) names.add(name);
  return [...names].sort();
}

/** The text of the "## Environment" section, or "" when the README has none. */
function environmentSection(readme: string): string {
  return readme.split(/^## /m).find((part) => part.startsWith("Environment")) ?? "";
}

/** The first cell of a Markdown table row, or "" for another line. */
function firstCell(line: string): string {
  return /^\|([^|]*)\|/.exec(line)?.[1] ?? "";
}

/** The `LOOP_*` names in the first cell of each row of the "## Environment" table of the README. */
export function envNamesInReadme(readme: string): string[] {
  return envNamesInCode(environmentSection(readme).split("\n").map(firstCell));
}

export interface EnvDrift {
  /** Read by the code, but no README row. */
  missingInReadme: string[];
  /** README row, but the code does not read it. */
  missingInCode: string[];
}

/** The names that only one of the two lists has. Both lists empty: no drift. */
export function envDrift(code: readonly string[], readme: readonly string[]): EnvDrift {
  return {
    missingInReadme: code.filter((name) => !readme.includes(name)),
    missingInCode: readme.filter((name) => !code.includes(name)),
  };
}

/** True when the text has the shell pattern that hides a failure. */
export function hidesFailure(text: string): boolean {
  return /\|\|\s*true\b/.test(text);
}
