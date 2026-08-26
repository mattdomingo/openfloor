import { resolveReviewRollbackImpact } from "@/db/review-contributions";
import { AgentRunConflictError } from "@/db/runs";
import type { AgentRunRollbackScope } from "@/lib/floor-types";
import { isApiError, requireApiUser } from "@/lib/server-auth";

const SCOPES = new Set<AgentRunRollbackScope>(["prompt", "engineer", "agent"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id } = await params;
  const url = new URL(request.url);
  const scope = url.searchParams.get("scope") as AgentRunRollbackScope | null;
  const subjectId = url.searchParams.get("subjectId")?.trim();
  if (!scope || !SCOPES.has(scope) || !subjectId || !UUID_PATTERN.test(subjectId)) return Response.json({ error: "Invalid rollback impact request" }, { status: 400 });
  try {
    const impact = await resolveReviewRollbackImpact(id, user.id, scope, subjectId);
    return impact ? Response.json({ impact }) : Response.json({ error: "Rollback not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof AgentRunConflictError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
}
