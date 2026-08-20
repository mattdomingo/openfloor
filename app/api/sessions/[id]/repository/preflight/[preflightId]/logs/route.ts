import { env } from "cloudflare:workers";
import { getPreflightLogKeysForMember } from "@/db/preflights";
import { isApiError, requireApiUser } from "@/lib/server-auth";

type R2ObjectLike = { text(): Promise<string> };
type R2BucketLike = { get(key: string): Promise<R2ObjectLike | null> };
const MAX_RESPONSE_CHARS = 500_000;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; preflightId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, preflightId } = await params;
  const keys = await getPreflightLogKeysForMember(sessionId, preflightId, user.id);
  if (!keys) return Response.json({ error: "Session not found" }, { status: 404 });
  const bucket = (env as unknown as { PREFLIGHT_LOGS?: R2BucketLike }).PREFLIGHT_LOGS;
  if (!bucket) return Response.json({ error: "Preflight logs are unavailable" }, { status: 503 });
  let output = "";
  for (const item of keys) {
    const object = await bucket.get(item.logKey);
    if (!object) continue;
    const log = await object.text();
    output += `${output ? "\n\n" : ""}$ ${item.command}\n${log}`;
    if (output.length >= MAX_RESPONSE_CHARS) {
      output = `${output.slice(0, MAX_RESPONSE_CHARS)}\n\n[openfloor truncated the combined log response]`;
      break;
    }
  }
  return new Response(output || "No command output is available.", {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}
