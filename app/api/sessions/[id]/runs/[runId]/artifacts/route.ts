import { getRunArtifactKeysForMember } from "@/db/runs";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { env } from "cloudflare:workers";

type R2ObjectLike = { text(): Promise<string> };
type R2BucketLike = { get(key: string): Promise<R2ObjectLike | null> };
const MAX_RESPONSE_CHARS = 1_000_000;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, runId } = await params;
  const artifacts = await getRunArtifactKeysForMember(sessionId, runId, user.id);
  if (!artifacts) return Response.json({ error: "Session not found" }, { status: 404 });
  const bucket = (env as unknown as { PREFLIGHT_LOGS?: R2BucketLike }).PREFLIGHT_LOGS;
  if (!bucket) return Response.json({ error: "Run artifacts are unavailable" }, { status: 503 });
  let output = "";
  for (const artifact of artifacts) {
    const object = await bucket.get(artifact.r2Key);
    if (!object) continue;
    const text = await object.text();
    output += `## ${artifact.kind}\n${text}\n`;
    if (output.length >= MAX_RESPONSE_CHARS) break;
  }
  return new Response(output.slice(0, MAX_RESPONSE_CHARS), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
