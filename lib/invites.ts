const encoder = new TextEncoder();

export async function signInviteId(inviteId: string, secret: string): Promise<string> {
  const signature = await hmac(inviteId, secret);
  return `${inviteId}.${toBase64Url(signature)}`;
}

export async function verifyInviteToken(token: string, secret: string): Promise<string | null> {
  const separator = token.lastIndexOf(".");
  if (separator <= 0) return null;
  const inviteId = token.slice(0, separator);
  const supplied = token.slice(separator + 1);
  if (!/^[0-9a-f-]{36}$/i.test(inviteId) || !supplied) return null;

  const expected = toBase64Url(await hmac(inviteId, secret));
  return constantTimeEqual(supplied, expected) ? inviteId : null;
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

function toBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  const max = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < max; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
