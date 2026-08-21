import { updateProfile } from "@/db/sessions";
import { deleteAvatar, putAvatar } from "@/lib/account-avatar";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseProfileInput } from "@/lib/validation";

export async function PATCH(request: Request) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;

  const form = await request.formData();
  const input = parseProfileInput({
    firstName: String(form.get("firstName") ?? ""),
    lastName: String(form.get("lastName") ?? ""),
    githubHandle: String(form.get("githubHandle") ?? ""),
  });
  if (!input) return Response.json({ error: "A first and last name are required." }, { status: 400 });

  const avatar = form.get("avatar");
  const removeAvatar = form.get("removeAvatar") === "true";
  if (avatar instanceof File && avatar.size > 0 && removeAvatar) {
    return Response.json({ error: "Cannot upload and remove a profile picture at the same time." }, { status: 400 });
  }

  let avatarKey: string | null | undefined;
  if (avatar instanceof File && avatar.size > 0) {
    const uploaded = await putAvatar(user.id, avatar);
    if (!uploaded.ok) return Response.json({ error: uploaded.error }, { status: uploaded.status });
    avatarKey = uploaded.key;
  } else if (removeAvatar) {
    await deleteAvatar(user.id);
    avatarKey = null;
  }

  const updated = await updateProfile(user.id, { ...input, avatarKey });
  return Response.json({ user: updated });
}
