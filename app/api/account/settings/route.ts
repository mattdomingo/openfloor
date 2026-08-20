import { setDoNotDisturb } from "@/db/sessions";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function PATCH(request: Request) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;

  const body = await request.json().catch(() => null) as { doNotDisturb?: unknown } | null;
  if (!body || typeof body.doNotDisturb !== "boolean") {
    return Response.json({ error: "doNotDisturb must be a boolean" }, { status: 400 });
  }

  const updated = await setDoNotDisturb(user.id, body.doNotDisturb);
  return Response.json({ user: updated });
}
