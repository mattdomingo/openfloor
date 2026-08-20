import { getRunArtifactKeysForMember } from "@/db/runs";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { env } from "cloudflare:workers";

type R2ObjectLike = { text(): Promise<string> };
type R2BucketLike = { get(key: string): Promise<R2ObjectLike | null> };
const MAX_RESPONSE_CHARS = 1_000_000;
// Unfiltered requests (the existing "Open raw log" expander) keep returning
// exactly what they always have: codex_log + diff, headed blocks. "prompt" is
// deliberately excluded from the default view — it's a distinct artifact,
// fetched only via an explicit ?kind=prompt request, one artifact with no
// heading.
const DEFAULT_KINDS = new Set(["codex_log", "diff"]);

export async function GET(request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, runId } = await params;
  const kindFilter = new URL(request.url).searchParams.get("kind");
  const artifacts = await getRunArtifactKeysForMember(sessionId, runId, user.id);
  if (!artifacts) return Response.json({ error: "Session not found" }, { status: 404 });
  const bucket = (env as unknown as { PREFLIGHT_LOGS?: R2BucketLike }).PREFLIGHT_LOGS;
  if (!bucket) return Response.json({ error: "Run artifacts are unavailable" }, { status: 503 });
  let output = "";
  for (const artifact of artifacts) {
    if (kindFilter ? artifact.kind !== kindFilter : !DEFAULT_KINDS.has(artifact.kind)) continue;
    const object = await bucket.get(artifact.r2Key);
    if (!object) continue;
    const text = await object.text();
    output += kindFilter ? text : `## ${artifact.kind}\n${text}\n`;
    if (output.length >= MAX_RESPONSE_CHARS) break;
  }
  return new Response(output.slice(0, MAX_RESPONSE_CHARS), { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}
