import { findUserById } from "@/db/sessions";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { env } from "cloudflare:workers";

type R2ObjectLike = { body: ReadableStream; httpMetadata?: { contentType?: string } };
type R2BucketLike = { get(key: string): Promise<R2ObjectLike | null> };

export async function GET(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const requester = await requireApiUser();
  if (isApiError(requester)) return requester;

  const { userId } = await params;
  const target = await findUserById(userId);
  if (!target?.avatarKey) return new Response(null, { status: 404 });

  const bucket = (env as unknown as { USER_AVATARS?: R2BucketLike }).USER_AVATARS;
  if (!bucket) return new Response(null, { status: 404 });

  const object = await bucket.get(target.avatarKey);
  if (!object) return new Response(null, { status: 404 });

  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "private, max-age=300",
    },
  });
}
