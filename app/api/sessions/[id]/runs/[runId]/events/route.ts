import { getRunEventsForMember } from "@/db/runs";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id: sessionId, runId } = await params;
  const rawAfter = Number(new URL(request.url).searchParams.get("after") ?? 0);
  const after = Number.isSafeInteger(rawAfter) && rawAfter > 0 ? rawAfter : 0;
  const events = await getRunEventsForMember(sessionId, runId, user.id, after);
  if (!events) return Response.json({ error: "Session not found" }, { status: 404 });
  return Response.json({ events }, { headers: { "cache-control": "no-store" } });
}
