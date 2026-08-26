import { listUserGitHubInstallations } from "@/db/github-installations";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function GET() {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  return Response.json({ installations: await listUserGitHubInstallations(user.id) });
}
