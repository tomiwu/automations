import { parseBotDraft, type BotRecord, type BotRegistry } from "./registry.ts";

export interface RegisterDeps {
  familyId: string;
  registry: BotRegistry;
  seal(slug: string, webhookKey: string): Promise<string>;
}

export interface RegisterResult {
  ok: true;
  slug: string;
}

/**
 * Adds or updates one registry row. The hub calls this after it creates a bot.
 * The webhook key is encrypted before it is stored. The result does not contain the key.
 */
export async function registerBot(deps: RegisterDeps, raw: unknown): Promise<RegisterResult> {
  const draft = parseBotDraft(raw, true);
  const ciphertext = await deps.seal(draft.slug, draft.webhookKey);
  await deps.registry.upsert(deps.familyId, toRecord(draft, ciphertext));
  return { ok: true, slug: draft.slug };
}

/** Saves an admin edit. An empty webhook key keeps the stored ciphertext. */
export async function saveBotEdit(deps: RegisterDeps, raw: unknown, existing: BotRecord | null): Promise<RegisterResult> {
  const draft = parseBotDraft(raw, existing === null);
  const ciphertext = await ciphertextFor(deps, draft.slug, draft.webhookKey, existing);
  await deps.registry.upsert(deps.familyId, toRecord(draft, ciphertext));
  return { ok: true, slug: draft.slug };
}

async function ciphertextFor(deps: RegisterDeps, slug: string, webhookKey: string, existing: BotRecord | null): Promise<string> {
  if (webhookKey !== "") return deps.seal(slug, webhookKey);
  if (existing) return existing.webhookKeyCiphertext;
  throw new Error("webhookKey is required.");
}

function toRecord(draft: { slug: string; name: string; description: string; activeHours: string; webhookUrl: string; active: boolean }, ciphertext: string): BotRecord {
  return {
    slug: draft.slug,
    name: draft.name,
    description: draft.description,
    activeHours: draft.activeHours,
    webhookUrl: draft.webhookUrl,
    webhookKeyCiphertext: ciphertext,
    active: draft.active,
  };
}
