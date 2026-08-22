import { SessionEndedError } from "@/db/sessions";
import { deleteSessionSkill } from "@/db/skills";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string; skillId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id, skillId } = await params;
  try {
    const skills = await deleteSessionSkill(id, user.id, skillId);
    if (!skills) return Response.json({ error: "Session not found" }, { status: 404 });
    return Response.json({ skills });
  } catch (error) {
    if (error instanceof SessionEndedError) return Response.json({ error: error.message }, { status: 409 });
    throw error;
  }
}
