// AES-256-GCM encryption for provider credentials at rest. The key is derived
// (SHA-256) from the CREDENTIAL_ENCRYPTION_KEY Worker secret; the caller
// resolves the secret (db/index.ts) so this module stays unit-testable with
// literal values, same as lib/invites.ts. `context` is bound as AAD, so a
// ciphertext moved to another user/provider row fails to decrypt.

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const IV_BYTES = 12;

async function importAesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptCredential(value: string, secret: string, context: string): Promise<string> {
  const key = await importAesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
    key,
    encoder.encode(value),
  );
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptCredential(payload: string, secret: string, context: string): Promise<string | null> {
  const [ivPart, ciphertextPart, extra] = payload.split(".");
  if (!ivPart || !ciphertextPart || extra !== undefined) return null;
  const iv = fromBase64Url(ivPart);
  const ciphertext = fromBase64Url(ciphertextPart);
  if (!iv || iv.byteLength !== IV_BYTES || !ciphertext) return null;
  try {
    const key = await importAesKey(secret);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
      key,
      ciphertext,
    );
    return decoder.decode(plaintext);
  } catch {
    return null;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}
