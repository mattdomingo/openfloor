import { activateRepositoryCandidate, failRepositoryCandidate } from "@/db/repositories";
import type { GitHubAppConfig } from "./github";
import { createRepositoryBranch, getRepositoryRefSha, GitHubApiError } from "./github";
import type { GitHubRepositoryOption } from "./session-types";

export async function provisionReservedRepositoryCandidate(input: {
  config: GitHubAppConfig;
  sessionId: string;
  candidateId: string;
  installationId: string;
  repository: GitHubRepositoryOption;
  branchName: string;
  baseSha: string;
}): Promise<string> {
  try {
    let remoteSha: string | null = null;
    try {
      remoteSha = await getRepositoryRefSha(input.config, input.installationId, input.repository, input.branchName);
    } catch (error) {
      if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
    }
    if (remoteSha && remoteSha !== input.baseSha) {
      throw new GitHubApiError("Candidate branch exists at an unexpected SHA", 409);
    }
    let candidateSha = remoteSha;
    if (!candidateSha) {
      try {
        candidateSha = await createRepositoryBranch(
          input.config, input.installationId, input.repository, input.branchName, input.baseSha,
        );
      } catch (error) {
        // A concurrent creator can win between the GET and POST. Reconcile
        // that ambiguous conflict before declaring setup failed; only the
        // exact expected base SHA is safe to adopt.
        if (!(error instanceof GitHubApiError) || error.status !== 422) throw error;
        const racedSha = await getRepositoryRefSha(input.config, input.installationId, input.repository, input.branchName);
        if (racedSha !== input.baseSha) throw new GitHubApiError("Candidate branch exists at an unexpected SHA", 409);
        candidateSha = racedSha;
      }
    }
    if (candidateSha !== input.baseSha) throw new GitHubApiError("GitHub created the candidate at an unexpected SHA", 502);
    await activateRepositoryCandidate(input.sessionId, input.candidateId, candidateSha);
    return candidateSha;
  } catch (error) {
    await failRepositoryCandidate(input.candidateId);
    throw error;
  }
}
