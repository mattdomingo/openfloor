import { getSessionMembers } from "@/db/sessions";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id } = await params;
  const members = await getSessionMembers(id, user.id);
  return members
    ? Response.json({ members })
    : Response.json({ error: "Session not found" }, { status: 404 });
}
