import { getAgentRunHistoryForMember } from "@/db/runs";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id } = await params;
  const before = new URL(request.url).searchParams.get("before");
  if (before !== null && (before.length === 0 || before.length > 100)) return Response.json({ error: "Invalid run cursor" }, { status: 400 });
  const history = await getAgentRunHistoryForMember(id, user.id, before);
  if (!history) return Response.json({ error: "Session not found" }, { status: 404 });
  return Response.json(history, { headers: { "cache-control": "no-store" } });
}
