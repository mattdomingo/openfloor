const encoder = new TextEncoder();

export async function signGitHubStateId(stateId: string, secret: string): Promise<string> {
  const signature = await hmac(stateId, secret);
  return `${stateId}.${toBase64Url(signature)}`;
}

export async function verifyGitHubStateToken(token: string, secret: string): Promise<string | null> {
  const separator = token.lastIndexOf(".");
  if (separator <= 0 || separator === token.length - 1) return null;
  const stateId = token.slice(0, separator);
  const supplied = fromBase64Url(token.slice(separator + 1));
  if (!supplied) return null;
  const expected = new Uint8Array(await hmac(stateId, secret));
  if (supplied.length !== expected.length) return null;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= supplied[index] ^ expected[index];
  return difference === 0 ? stateId : null;
}

export async function verifyGitHubWebhookSignature(
  payload: ArrayBuffer,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const suppliedHex = signatureHeader.slice("sha256=".length);
  if (!/^[0-9a-f]{64}$/i.test(suppliedHex)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, payload));
  const supplied = new Uint8Array(suppliedHex.match(/.{2}/g)!.map((value) => Number.parseInt(value, 16)));
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) difference |= supplied[index] ^ expected[index];
  return difference === 0;
}

async function hmac(value: string, secret: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, encoder.encode(value));
}

function toBase64Url(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}
