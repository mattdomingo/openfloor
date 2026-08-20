import { completeOnboarding } from "@/db/sessions";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { env } from "cloudflare:workers";

type R2BucketLike = { put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown> };

const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const ACCEPTED_AVATAR_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_NAME_LENGTH = 50;
const MAX_GITHUB_HANDLE_LENGTH = 39;

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;

  const form = await request.formData();
  const firstName = String(form.get("firstName") ?? "").trim();
  const lastName = String(form.get("lastName") ?? "").trim();
  const githubHandle = String(form.get("githubHandle") ?? "").trim();
  const avatar = form.get("avatar");

  if (!firstName || firstName.length > MAX_NAME_LENGTH) return Response.json({ error: "First name is required." }, { status: 400 });
  if (!lastName || lastName.length > MAX_NAME_LENGTH) return Response.json({ error: "Last name is required." }, { status: 400 });
  if (githubHandle.length > MAX_GITHUB_HANDLE_LENGTH) return Response.json({ error: "GitHub handle is too long." }, { status: 400 });

  let avatarKey: string | null = null;
  if (avatar instanceof File && avatar.size > 0) {
    if (!ACCEPTED_AVATAR_TYPES.has(avatar.type)) return Response.json({ error: "Profile pictures must be a PNG, JPEG, or WebP image." }, { status: 400 });
    if (avatar.size > MAX_AVATAR_BYTES) return Response.json({ error: "Profile pictures must be 5MB or smaller." }, { status: 400 });
    const bucket = (env as unknown as { USER_AVATARS?: R2BucketLike }).USER_AVATARS;
    if (!bucket) return Response.json({ error: "Profile picture uploads are unavailable." }, { status: 503 });
    avatarKey = `users/${user.id}/avatar`;
    await bucket.put(avatarKey, await avatar.arrayBuffer(), { httpMetadata: { contentType: avatar.type } });
  }

  await completeOnboarding(user.id, { firstName, lastName, githubHandle: githubHandle || null, avatarKey });
  return new Response(null, { status: 204 });
}
