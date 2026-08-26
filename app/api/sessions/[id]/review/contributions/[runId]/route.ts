import { getReviewContribution } from "@/db/review-contributions";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string; runId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id, runId } = await params;
  const contribution = await getReviewContribution(id, runId, user.id);
  return contribution
    ? Response.json({ contribution })
    : Response.json({ error: "Contribution not found" }, { status: 404 });
}
