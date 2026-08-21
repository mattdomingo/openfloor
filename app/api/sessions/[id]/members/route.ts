import { getRemovedSessionMembers, getSessionMembers } from "@/db/sessions";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id } = await params;
  const members = await getSessionMembers(id, user.id);
  if (!members) return Response.json({ error: "Session not found" }, { status: 404 });
  // null for non-owners (owner-gated inside getRemovedSessionMembers); the
  // roster UI only renders this list for the owner anyway.
  const removedMembers = (await getRemovedSessionMembers(id, user.id)) ?? [];
  return Response.json({ members, removedMembers });
}
