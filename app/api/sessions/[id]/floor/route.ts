import { getFloorSnapshot } from "@/db/floor";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const { id } = await params;
  const floor = await getFloorSnapshot(id, user.id);
  return floor ? Response.json({ floor }) : Response.json({ error: "Session not found" }, { status: 404 });
}
