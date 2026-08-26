import { getGitHubAppConfig } from "@/db";
import { listAccountGitHubRepositories } from "@/db/github-installations";
import { GitHubApiError } from "@/lib/github";
import { isApiError, requireApiUser } from "@/lib/server-auth";

export async function GET() {
  const user = await requireApiUser();
  if (isApiError(user)) return user;
  try {
    return Response.json({ repositories: await listAccountGitHubRepositories(user.id, getGitHubAppConfig()) });
  } catch (error) {
    if (error instanceof GitHubApiError) {
      return Response.json({ error: "GitHub repository access is unavailable" }, { status: error.status === 404 ? 404 : 502 });
    }
    throw error;
  }
}
