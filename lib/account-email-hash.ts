import { normalizeEmail } from "./identity";

// Domain-separated from invite signatures (lib/invites.ts uses the same
// secret over a bare invite id) even though both key off
// INVITE_SIGNING_SECRET — the prefix keeps the two hash spaces disjoint.
const DOMAIN_PREFIX = "openfloor:free-allowance:v1:";
const encoder = new TextEncoder();

// HMAC (not a bare digest): the address space is small enough to enumerate
// against an unsalted SHA-256, and a keyed hash keeps this comparable only
// by someone holding the secret. Rotating INVITE_SIGNING_SECRET invalidates
// every stored prior_email_hash and fails open — a returning user regains
// the free allowance rather than being wrongly denied it. See the
// users.priorEmailHash comment in db/schema.ts and the 2026-08-26
// decision-log entry.
export async function hashAccountEmail(email: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(DOMAIN_PREFIX + normalizeEmail(email)));
  return Array.from(new Uint8Array(signature)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
