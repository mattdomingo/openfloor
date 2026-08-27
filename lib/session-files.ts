// Server-only R2 access for session files (ENG-113), the account-avatar.ts
// pattern: bytes live in PREFLIGHT_LOGS — already the session blob store
// (run prompts, logs, diffs) — under sessions/{sessionId}/files/{fileId};
// the session_files D1 row is the authority for existence and authorization.
import { env } from "cloudflare:workers";

type R2ObjectLike = { body: ReadableStream; httpMetadata?: { contentType?: string } };
type R2BucketLike = {
  put(key: string, value: ArrayBuffer, options?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
};

export function sessionFileKey(sessionId: string, fileId: string): string {
  return `sessions/${sessionId}/files/${fileId}`;
}

function getBucket(): R2BucketLike | null {
  return (env as unknown as { PREFLIGHT_LOGS?: R2BucketLike }).PREFLIGHT_LOGS ?? null;
}

export async function putSessionFileObject(key: string, file: File): Promise<boolean> {
  const bucket = getBucket();
  if (!bucket) return false;
  await bucket.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
  return true;
}

export async function getSessionFileObject(key: string): Promise<R2ObjectLike | null> {
  const bucket = getBucket();
  if (!bucket) return null;
  return bucket.get(key);
}

// Best-effort, for unwinding R2 writes when the D1 insert refuses (ended
// session, membership race). The D1 row is the source of truth, so a
// leftover object is unreachable garbage, not a leak.
export async function deleteSessionFileObjects(keys: string[]): Promise<void> {
  const bucket = getBucket();
  if (!bucket) return;
  await Promise.allSettled(keys.map((key) => bucket.delete(key)));
}
