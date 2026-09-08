import { getSessionPromptHistory } from "@/db/prompt-history";
import { requireApiUser, isApiError } from "@/lib/server-auth";

export async function GET(request: Request, { params }: { params: Promise<{ id: string; promptId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id, promptId } = await params;
  const query = new URL(request.url).searchParams;
  if ([...query.values()].some((value) => value.length > 100)) return Response.json({ error: "Invalid history filter" }, { status: 400 });
  try {
    const result = await getSessionPromptHistory(id, user.id, promptId, query.get("before"));
    return result ? Response.json(result, { headers: { "cache-control": "no-store" } }) : Response.json({ error: "Session not found" }, { status: 404 });
  } catch (error) {
    if (error instanceof Error && (error.message === "Invalid prompt cursor" || error.message === "Invalid run cursor")) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
