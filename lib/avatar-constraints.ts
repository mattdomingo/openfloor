// Avatar accept/size limits shared by client pickers (onboarding, account
// settings) and server-side validation (lib/account-avatar.ts). Split out
// from lib/account-avatar.ts specifically because that module imports
// cloudflare:workers for the R2 binding and so cannot be pulled into a
// "use client" bundle — this file has no such import, same rationale as
// lib/plans.ts staying reachable from tests/unit under plain node.
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
export const ACCEPTED_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
// Client pickers need this as a plain list for an <input accept> attribute.
export const ACCEPTED_AVATAR_TYPE_LIST = Array.from(ACCEPTED_AVATAR_TYPES);
