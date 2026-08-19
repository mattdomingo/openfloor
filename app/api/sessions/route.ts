import { BASE_PATH } from "@/components/basePath";
import { createSession } from "@/db/sessions";
import { signInviteId } from "@/lib/invites";
import { getInviteSigningSecret } from "@/db";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseSessionInput } from "@/lib/validation";

export async function POST(request: Request) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const input = parseSessionInput(body);
  if (!input) return Response.json({ error: "A title under 100 characters is required" }, { status: 400 });

  const created = await createSession(user.id, input);
  const token = await signInviteId(created.inviteId, getInviteSigningSecret());
  const inviteUrl = new URL(`${BASE_PATH}/join/${encodeURIComponent(token)}`, request.url).toString();
  return Response.json({ session: created.session, inviteUrl }, { status: 201 });
}
