import type { AppUser } from "./session-types";

export const EARLY_ACCESS_CONSENT_VERSION = "2026-08-31";
export const EARLY_ACCESS_PENDING_TTL_MS = 15 * 60_000;
export const EARLY_ACCESS_RETENTION_MS = 365 * 24 * 60 * 60_000;
export const EARLY_ACCESS_SOCKET_CLOSE_CODE = 4006;
export const EARLY_ACCESS_PENDING_COOKIE = "openfloor_early_access_pending";

const encoder = new TextEncoder();

export type EarlyAccessBindings = {
  EARLY_ACCESS_GATE_ENABLED?: string;
  EARLY_ACCESS_PASSWORD?: string;
  WAITLIST_SHEET_WEBHOOK_URL?: string;
  WAITLIST_SHEET_WEBHOOK_SECRET?: string;
};

export function earlyAccessGateEnabled(bindings: EarlyAccessBindings): boolean {
  return bindings.EARLY_ACCESS_GATE_ENABLED === "true";
}

export function hasEarlyAccess(user: Pick<AppUser, "earlyAccessGrantedAt" | "earlyAccessRevokedAt">): boolean {
  return user.earlyAccessGrantedAt != null && user.earlyAccessRevokedAt == null;
}

export async function verifyEarlyAccessPasscode(candidate: string, configured: string | undefined): Promise<boolean> {
  if (!configured || !candidate || candidate.length > 256) return false;
  const [candidateHash, configuredHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(candidate)),
    crypto.subtle.digest("SHA-256", encoder.encode(configured)),
  ]);
  return constantTimeEqual(new Uint8Array(candidateHash), new Uint8Array(configuredHash));
}

export async function signPendingEarlyAccess(secret: string, now = Date.now()): Promise<string> {
  const payload = JSON.stringify({ v: 1, iat: now, exp: now + EARLY_ACCESS_PENDING_TTL_MS });
  const encodedPayload = base64UrlEncode(encoder.encode(payload));
  const signature = await hmac(secret, `openfloor:early-access:pending:v1:${encodedPayload}`);
  return `${encodedPayload}.${base64UrlEncode(signature)}`;
}

export async function verifyPendingEarlyAccess(token: string | undefined, secret: string | undefined, now = Date.now()): Promise<boolean> {
  if (!token || !secret) return false;
  const [encodedPayload, encodedSignature, extra] = token.split(".");
  if (!encodedPayload || !encodedSignature || extra !== undefined) return false;
  let payload: { v?: unknown; iat?: unknown; exp?: unknown };
  let supplied: Uint8Array;
  try {
    payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload))) as typeof payload;
    supplied = base64UrlDecode(encodedSignature);
  } catch {
    return false;
  }
  if (payload.v !== 1 || typeof payload.iat !== "number" || typeof payload.exp !== "number") return false;
  if (payload.iat > now + 60_000 || payload.exp < now || payload.exp - payload.iat !== EARLY_ACCESS_PENDING_TTL_MS) return false;
  const expected = await hmac(secret, `openfloor:early-access:pending:v1:${encodedPayload}`);
  return constantTimeEqual(supplied, expected);
}

export async function signWaitlistSheetPayload(secret: string, timestamp: number, payload: string): Promise<string> {
  return hex(await hmac(secret, `${timestamp}.${payload}`));
}

async function hmac(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return mismatch === 0;
}

function base64UrlEncode(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function hex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
