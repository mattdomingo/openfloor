import { removeUserGitHubInstallation } from "@/db/github-installations";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function DELETE(_request: Request, { params }: { params: Promise<{ installationId: string }> }) {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  const removed = await removeUserGitHubInstallation(user.id, (await params).installationId);
  return removed ? new Response(null, { status: 204 }) : Response.json({ error: "GitHub installation not found" }, { status: 404 });
}
