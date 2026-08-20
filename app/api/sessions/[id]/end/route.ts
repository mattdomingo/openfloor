import { endSession } from "@/db/sessions";
import { notifySessionEnded } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const result = await endSession(sessionId, user.id);
  if (result === "missing") return Response.json({ error: "Session not found" }, { status: 404 });
  if (result === "forbidden") return Response.json({ error: "Only the owner can end this session" }, { status: 403 });
  if ("blocked" in result) return Response.json({ error: "A run is still integrating into this candidate", runId: result.runId }, { status: 409 });
  await notifySessionEnded(sessionId, result.endedAt, result.reason);
  return new Response(null, { status: 204 });
}
