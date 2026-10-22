import { decryptCredential, encryptCredential } from "@automations/shared";

/** Binds a bot webhook key to the Family and the slug. */
export function botKeyName(slug: string): string {
  return `kradziejka-bot:${slug}`;
}

/** Encrypts one bot webhook key. The result is `v1.<iv>.<data>`. */
export async function sealWebhookKey(key: CryptoKey, familyId: string, slug: string, value: string): Promise<string> {
  return encryptCredential(key, familyId, botKeyName(slug), value);
}

/** Decrypts one bot webhook key. A copied row for another slug does not decrypt. */
export async function openWebhookKey(key: CryptoKey, familyId: string, slug: string, sealed: string): Promise<string> {
  return decryptCredential(key, familyId, botKeyName(slug), sealed);
}
