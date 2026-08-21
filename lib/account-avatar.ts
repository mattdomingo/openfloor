// Shared R2 avatar storage, used by the onboarding upload
// (app/api/account/onboarding/route.ts) and account settings
// (app/api/account/profile/route.ts) so the two endpoints can't drift on
// accepted types, size limits, or the object key layout.
import { env } from "cloudflare:workers";
import { ACCEPTED_AVATAR_TYPES, MAX_AVATAR_BYTES } from "./avatar-constraints";

type R2BucketLike = {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  delete(key: string): Promise<void>;
};

export function avatarKeyFor(userId: string): string {
  return `users/${userId}/avatar`;
}

function getAvatarBucket(): R2BucketLike | null {
  return (env as unknown as { USER_AVATARS?: R2BucketLike }).USER_AVATARS ?? null;
}

export type PutAvatarResult = { ok: true; key: string } | { ok: false; status: number; error: string };

export async function putAvatar(userId: string, avatar: File): Promise<PutAvatarResult> {
  if (!ACCEPTED_AVATAR_TYPES.has(avatar.type)) {
    return { ok: false, status: 400, error: "Profile pictures must be a PNG, JPEG, or WebP image." };
  }
  if (avatar.size > MAX_AVATAR_BYTES) {
    return { ok: false, status: 400, error: "Profile pictures must be 5MB or smaller." };
  }
  const bucket = getAvatarBucket();
  if (!bucket) return { ok: false, status: 503, error: "Profile picture uploads are unavailable." };
  const key = avatarKeyFor(userId);
  await bucket.put(key, await avatar.arrayBuffer(), { httpMetadata: { contentType: avatar.type } });
  return { ok: true, key };
}

// Best-effort: if the bucket binding is unavailable, the caller still clears
// avatar_key in D1 (the source of truth for whether an avatar exists — see
// app/api/account/avatar/[userId]/route.ts, which 404s once avatar_key is
// null regardless of what's left in R2).
export async function deleteAvatar(userId: string): Promise<void> {
  const bucket = getAvatarBucket();
  if (!bucket) return;
  await bucket.delete(avatarKeyFor(userId));
}
