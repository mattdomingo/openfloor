import { listReviewContributions } from "@/db/review-contributions";
import { AgentRunNotReadyError } from "@/db/runs";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id } = await params;
  const url = new URL(request.url);
  const status = url.searchParams.get("status") === "rolled_back" ? "rolled_back" : "active";
  const limitValue = Number(url.searchParams.get("limit") ?? 25);
  try {
    const page = await listReviewContributions(id, user.id, {
      status,
      cursor: url.searchParams.get("cursor"),
      limit: Number.isFinite(limitValue) ? limitValue : 25,
      path: url.searchParams.get("path"),
      engineerId: url.searchParams.get("engineerId"),
      agentId: url.searchParams.get("agentId"),
    });
    return page ? Response.json(page) : Response.json({ error: "Session not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof AgentRunNotReadyError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
