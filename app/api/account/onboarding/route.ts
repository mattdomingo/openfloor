import { completeOnboarding } from "@/db/sessions";
import { putAvatar } from "@/lib/account-avatar";
import { isApiError, requireApiUser } from "@/lib/server-auth";
import { parseProfileInput } from "@/lib/validation";

export async function POST(request: Request) {
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
  let avatarKey: string | null = null;
  if (avatar instanceof File && avatar.size > 0) {
    const uploaded = await putAvatar(user.id, avatar);
    if (!uploaded.ok) return Response.json({ error: uploaded.error }, { status: uploaded.status });
    avatarKey = uploaded.key;
  }

  await completeOnboarding(user.id, { ...input, avatarKey });
  return new Response(null, { status: 204 });
}
