/** The object path in the `librus-attachments` bucket. */
export function attachmentObjectPath(familyId: string, messageId: string, attachmentId: string): string {
  return `${familyId}/${messageId}/${attachmentId}`;
}

/** A SHA-256 hex digest of the bytes. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}