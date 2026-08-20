import { archiveSessionForMember } from "@/db/sessions";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const result = await archiveSessionForMember(sessionId, user.id);
  if (result === "missing") return Response.json({ error: "Session not found" }, { status: 404 });
  return new Response(null, { status: 204 });
}
