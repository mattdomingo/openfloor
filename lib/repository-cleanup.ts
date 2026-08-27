import { getSandbox, type Sandbox } from "@cloudflare/sandbox";
import { env } from "cloudflare:workers";
import type { getGitHubAppConfig } from "@/db";
import { createInstallationToken, deleteTestRepositoryBranchIfMatches, getRepositoryRefSha, GitHubApiError } from "@/lib/github";
import type { GitHubRepositoryOption } from "@/lib/session-types";

export type CleanupTarget = { id: string | null; name: string; sha: string; candidate: boolean };

/* Shared by the merge route (run branches + optionally the candidate branch)
   and the deferred candidate-branch-delete route (candidate branch alone).
   Never deletes a branch unless its current GitHub SHA still matches what D1
   expects — a branch that moved (force-push, manual commit) is left alone,
   which is what produces cleanup_status: "partial". */
export async function deleteVerifiedBranches(
  config: ReturnType<typeof getGitHubAppConfig>,
  installationId: string,
  repository: GitHubRepositoryOption,
  targets: CleanupTarget[],
  candidateId: string,
): Promise<{ deletedRunIds: string[]; candidateDeleted: boolean; complete: boolean }> {
  const safe: CleanupTarget[] = [];
  const alreadyMissing: CleanupTarget[] = [];
  for (const target of targets) {
    try {
      const observed = await getRepositoryRefSha(config, installationId, repository, target.name);
      if (observed === target.sha) safe.push(target);
      else console.error(`branch cleanup skipped ${target.name}: expected ${target.sha}, GitHub has ${observed}`);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) alreadyMissing.push(target);
      else throw error;
    }
  }
  let deleted: CleanupTarget[] = [];
  if (config.testData) {
    for (const target of safe) {
      if (await deleteTestRepositoryBranchIfMatches(config, installationId, repository, target.name, target.sha)) deleted.push(target);
    }
  } else if (safe.length > 0) {
    const bindings = env as unknown as { SANDBOX?: DurableObjectNamespace<Sandbox> };
    if (!bindings.SANDBOX) throw new GitHubApiError("Safe branch cleanup is unavailable", 503);
    const sandbox = getSandbox(bindings.SANDBOX, `cleanup-v1-${candidateId}-${crypto.randomUUID()}`, { keepAlive: false, enableDefaultSession: false, normalizeId: true });
    try {
      const token = await createInstallationToken(config, installationId, repository.id);
      const result = await sandbox.exec("node /opt/openfloor/cleanup-branches.mjs", {
        timeout: 5 * 60 * 1000,
        env: {
          OPENFLOOR_CLEANUP_ROOT: `/workspace/cleanup-${candidateId}`,
          OPENFLOOR_REPOSITORY_URL: `https://github.com/${repository.owner}/${repository.name}.git`,
          OPENFLOOR_GITHUB_TOKEN: token,
          OPENFLOOR_BRANCHES: JSON.stringify(safe.map((target) => ({ name: target.name, sha: target.sha }))),
        },
      });
      if (!result.success) throw new GitHubApiError("Trusted branch cleanup failed", 502);
      const output = JSON.parse(result.stdout.trim()) as { deleted?: string[]; failed?: Array<{ name: string; error: string }> };
      deleted = safe.filter((target) => output.deleted?.includes(target.name));
      for (const failure of output.failed ?? []) console.error(`branch cleanup push failed for ${failure.name}: ${failure.error}`);
    } finally {
      await sandbox.destroy().catch(() => undefined);
    }
  }
  const cleared = [...alreadyMissing, ...deleted];
  return {
    deletedRunIds: cleared.flatMap((target) => target.id ? [target.id] : []),
    candidateDeleted: cleared.some((target) => target.candidate),
    complete: cleared.length === targets.length,
  };
}
