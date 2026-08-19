import { updateSessionObjective } from "@/db/sessions";
import { mutationErrorResponse } from "@/lib/floor-api";
import { notifySessionChanged } from "@/lib/presence-server";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseObjectiveInput } from "@/lib/validation";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const input = parseObjectiveInput(body);
  if (!input) return Response.json({ error: "Objective must be 2,000 characters or fewer" }, { status: 400 });

  try {
    const session = await updateSessionObjective((await params).id, user.id, input.objective);
    if (!session) return Response.json({ error: "Session not found" }, { status: 404 });
    await notifySessionChanged(session.id, { objective: session.objective, updatedAt: session.updatedAt });
    return Response.json({ session });
  } catch (error) {
    return mutationErrorResponse(error);
  }
}
