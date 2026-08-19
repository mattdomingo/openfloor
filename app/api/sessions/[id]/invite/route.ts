import { BASE_PATH } from "@/components/basePath";
import { getInviteSigningSecret } from "@/db";
import { getActiveInviteId, getMembershipRole, revokeInvite, rotateInvite } from "@/db/sessions";
import { signInviteId } from "@/lib/invites";
import { isApiError, requireApiUser } from "@/lib/server-auth";

async function ownerInvite(request: Request, sessionId: string, userId: string) {
  if ((await getMembershipRole(sessionId, userId)) !== "owner") {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }
  const inviteId = await getActiveInviteId(sessionId, userId);
  if (!inviteId) return Response.json({ inviteUrl: null });
  const token = await signInviteId(inviteId, getInviteSigningSecret());
  return Response.json({ inviteUrl: new URL(`${BASE_PATH}/join/${encodeURIComponent(token)}`, request.url).toString() });
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  return ownerInvite(request, (await params).id, user.id);
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const sessionId = (await params).id;
  const inviteId = await rotateInvite(sessionId, user.id);
  if (!inviteId) return Response.json({ error: "Session not found" }, { status: 404 });
  const token = await signInviteId(inviteId, getInviteSigningSecret());
  return Response.json({ inviteUrl: new URL(`${BASE_PATH}/join/${encodeURIComponent(token)}`, request.url).toString() });
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const ok = await revokeInvite((await params).id, user.id);
  return ok ? new Response(null, { status: 204 }) : Response.json({ error: "Session not found" }, { status: 404 });
}
