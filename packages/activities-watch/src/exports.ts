import { LANGUAGES, type Language } from "@automations/shared";
import { createAfterSchool } from "./after-school.ts";
import { collectSessions, type CollectDeps, type SessionsResult } from "./collect-sessions.ts";

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function inputObject(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new Error("Input must be an object.");
  return input as Record<string, unknown>;
}

function checkKeys(object: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`Unknown input key(s): ${unknown.join(", ")}.`);
}

/** Read-only export: every Session of every Child for the next 14 days, ordered by start. It takes no input. */
export async function sessionsExport(deps: CollectDeps, input: unknown = {}): Promise<SessionsResult> {
  checkKeys(inputObject(input), []);
  return collectSessions(deps);
}

export interface AfterSchoolInput {
  childId: string;
  day: string;
  language?: Language;
}

function checkLanguage(language: unknown): Language | undefined {
  if (language === undefined) return undefined;
  if (!(LANGUAGES as readonly unknown[]).includes(language)) throw new Error(`language must be one of ${LANGUAGES.join(", ")}.`);
  return language as Language;
}

function checkText(value: unknown, pattern: RegExp, message: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(message);
  return value;
}

/** Checks the input of the `after-school` export: a Child, a day and an optional language. */
export function parseAfterSchoolInput(input: unknown): AfterSchoolInput {
  const object = inputObject(input);
  checkKeys(object, ["childId", "day", "language"]);
  return {
    childId: checkText(object.childId, /./, "childId must be a text."),
    day: checkText(object.day, DAY_PATTERN, "day must be YYYY-MM-DD."),
    language: checkLanguage(object.language),
  };
}

/** Read-only export: the after-school section of one Child for one day. */
export async function afterSchoolExport(deps: CollectDeps, input: unknown): Promise<{ text: string }> {
  const { childId, day, language } = parseAfterSchoolInput(input);
  const config = await deps.storage.loadConfig(deps.familyId);
  const child = config.children.find((candidate) => candidate.id === childId);
  if (!child) throw new Error(`Unknown child: ${childId}.`);
  const text = await createAfterSchool(deps)(child, day, language ?? config.family.default_language);
  return { text };
}
