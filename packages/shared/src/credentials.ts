/**
 * Encryption of the service credentials (logins and passwords of Librus and the Activity apps) that live in
 * Supabase. AES-256-GCM with a random 96-bit IV. The additional data binds a ciphertext to its Family and name,
 * so a ciphertext copied to another row does not decrypt.
 *
 * Format: `v1.<base64 iv>.<base64 ciphertext and tag>`. The key is 32 random bytes in base64.
 */
const VERSION = "v1";
const encoder = new TextEncoder();

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Checks a base64 key of 32 bytes and imports it. */
export async function importCredentialKey(keyBase64: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = fromBase64(keyBase64);
  } catch {
    throw new Error("The credential key is not base64.");
  }
  if (raw.length !== 32) throw new Error("The credential key must be 32 bytes (base64).");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** Makes a new random credential key (base64). */
export function newCredentialKey(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

const additionalData = (familyId: string, name: string): Uint8Array<ArrayBuffer> => encoder.encode(`${familyId}:${name}`);

export async function encryptCredential(key: CryptoKey, familyId: string, name: string, value: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(familyId, name) },
    key,
    encoder.encode(value),
  );
  return `${VERSION}.${toBase64(iv)}.${toBase64(new Uint8Array(sealed))}`;
}

export async function decryptCredential(key: CryptoKey, familyId: string, name: string, sealed: string): Promise<string> {
  const [version, iv, data] = sealed.split(".");
  if (version !== VERSION || !iv || !data) throw new Error(`Credential ${name} has an unknown format.`);
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64(iv), additionalData: additionalData(familyId, name) },
      key,
      fromBase64(data),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error(`Credential ${name} does not decrypt (wrong key or changed row).`);
  }
}
